"""解析 QQ跑团Log导出器 导出的 TXT 日志。

导出格式：
    名字(QQ号) 2022/03/21 19:05:05
    消息内容（可能多行）
"""
import re
from datetime import datetime

HEADER_RE = re.compile(
    r'^(?P<name>.+?)\((?P<qq>[^()]+)\)\s+'
    r'(?P<time>\d{4}/\d{2}/\d{2}\s+\d{2}:\d{2}:\d{2})\s*$'
)
CONTROL_RE = re.compile(r'^[.。]log\s*(?P<cmd>new|on|end|off)(?![A-Za-z])', re.IGNORECASE)
SCENE_START_CMDS = {'new', 'on'}
# 章节标题，例如 “第一章 雨夜”“第3幕”。需要适配其他写法时修改这里。
CHAPTER_RE = re.compile(r'第[零〇一二三四五六七八九十百千万\d]+[章幕节回部](?:\s*.{0,50})?')
SYSTEM_QQS = {'10000', '80000000'}
SYSTEM_KEYWORDS = ('撤回了一条消息', '加入了群聊', '退出了群聊', '群公告')
DEFAULT_CHAPTER_TITLE = '全文'


def decode_bytes(data: bytes) -> str:
    if data.startswith(b'\xef\xbb\xbf'):
        return data[3:].decode('utf-8')
    if data.startswith(b'\xff\xfe'):
        return data[2:].decode('utf-16-le')
    if data.startswith(b'\xfe\xff'):
        return data[2:].decode('utf-16-be')
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        return data.decode('gb18030')


def mask_qq(qq: str) -> str:
    if not qq:
        return ''
    if len(qq) <= 4:
        return '*' * len(qq)
    return qq[:2] + '*' * (len(qq) - 4) + qq[-2:]


def _to_iso(time_text: str) -> str:
    normalized = ' '.join(time_text.split())
    return datetime.strptime(normalized, '%Y/%m/%d %H:%M:%S').strftime('%Y-%m-%d %H:%M:%S')


def _group_by_header(text: str):
    entries = []
    current = None
    for line in text.splitlines():
        match = HEADER_RE.match(line.rstrip())
        if match:
            current = (
                match.group('name').strip(),
                match.group('qq').strip(),
                _to_iso(match.group('time')),
                [],
            )
            entries.append(current)
        elif current is not None:
            current[3].append(line)
    return entries


def _is_system(qq: str, content: str) -> bool:
    return qq in SYSTEM_QQS or any(keyword in content for keyword in SYSTEM_KEYWORDS)


def parse_text(text: str) -> dict:
    """返回 {'chapters': [{'seq', 'title'}], 'messages': [...]}。

    每条消息包含 chapter_seq、speaker、qq_masked、sent_at、msg_type('rp'/'ooc')、content。
    """
    # 先把消息体按章节标题行切开；标题行本身不作为消息。
    events = []
    for speaker, qq, sent_at, lines in _group_by_header(text):
        body = []
        for line in lines:
            if CHAPTER_RE.fullmatch(line.strip()):
                events.append(('msg', speaker, qq, sent_at, body))
                events.append(('chapter', line.strip()))
                body = []
            else:
                body.append(line)
        events.append(('msg', speaker, qq, sent_at, body))

    return build_result(events)


def build_result(events, default_scene_on=False) -> dict:
    """events 为 ('chapter', 标题) 或 ('msg', 角色, QQ或None, 时间或None, 行列表)。"""
    titles = [DEFAULT_CHAPTER_TITLE]
    raw_messages = []
    scene_on = default_scene_on
    for event in events:
        if event[0] == 'chapter':
            titles.append(event[1])
            continue
        _, speaker, qq, sent_at, body = event
        content = '\n'.join(body).strip()
        if not content or _is_system(qq, content):
            continue
        control = CONTROL_RE.match(content)
        if control:
            scene_on = control.group('cmd').lower() in SCENE_START_CMDS
            continue
        is_ooc = (not scene_on) or content.startswith(('(', '（'))
        raw_messages.append({
            'chapter_index': len(titles) - 1,
            'speaker': speaker,
            'qq_masked': mask_qq(qq),
            'sent_at': sent_at,
            'msg_type': 'ooc' if is_ooc else 'rp',
            'content': content,
        })

    # 丢弃没有任何消息的“全文”默认章节；标题章节即使为空也保留。
    used = {m['chapter_index'] for m in raw_messages}
    keep = [i for i in range(len(titles)) if i > 0 or i in used]
    remap = {old: new for new, old in enumerate(keep)}
    chapters = [{'seq': remap[i], 'title': titles[i]} for i in keep]
    messages = []
    for m in raw_messages:
        item = dict(m)
        item['chapter_seq'] = remap[item.pop('chapter_index')]
        messages.append(item)
    return {'chapters': chapters, 'messages': messages}
