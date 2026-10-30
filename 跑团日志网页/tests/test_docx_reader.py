import shutil
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

import db  # noqa: E402
from app import create_app  # noqa: E402
from docx_reader import parse_docx  # noqa: E402

NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def _p(text):
    return f'<w:p><w:r><w:t xml:space="preserve">{escape(text)}</w:t></w:r></w:p>'


def _row(*cells):
    tcs = ''.join(f'<w:tc>{_p(c)}</w:tc>' for c in cells)
    return f'<w:tr>{tcs}</w:tr>'


def make_docx(path: Path, body_xml: str) -> None:
    document = f'<?xml version="1.0" encoding="UTF-8"?><w:document {NS}><w:body>{body_xml}</w:body></w:document>'
    with zipfile.ZipFile(path, 'w') as zf:
        zf.writestr('word/document.xml', document)


TABLE_BODY = (
    _p('第一章 雨夜')
    + '<w:tbl>'
    + _row('角色', 'RP')
    + _row('KP', '欢迎来到旅馆。')
    + _row('张三', '（推开门）')
    + _row('李四', '我看向窗外')
    + '</w:tbl>'
    + _p('第二章 林中')
    + '<w:tbl>' + _row('KP', '.log off') + _row('王五', '（场外闲聊）') + '</w:tbl>'
)


class DocxParserTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path = self.tmp / 'table.docx'
        make_docx(self.path, TABLE_BODY)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_table_rows_become_messages_without_time_or_qq(self):
        parsed = parse_docx(self.path)
        msgs = [(m['speaker'], m['content'], m['msg_type'], m['sent_at'], m['qq_masked']) for m in parsed['messages']]
        self.assertEqual(
            msgs,
            [
                ('KP', '欢迎来到旅馆。', 'rp', None, ''),
                ('张三', '（推开门）', 'ooc', None, ''),
                ('李四', '我看向窗外', 'rp', None, ''),
                ('王五', '（场外闲聊）', 'ooc', None, ''),
            ],
        )

    def test_table_header_row_skipped_and_chapters_detected(self):
        parsed = parse_docx(self.path)
        self.assertEqual([c['title'] for c in parsed['chapters']], ['第一章 雨夜', '第二章 林中'])
        self.assertEqual([m['chapter_seq'] for m in parsed['messages']], [0, 0, 0, 1])

    def test_paragraph_only_docx_uses_qq_format(self):
        path = self.tmp / 'qq.docx'
        make_docx(path, _p('玩家甲(11112222) 2022/03/21 19:05:05') + _p('我推开门。'))
        parsed = parse_docx(path)
        self.assertEqual(parsed['messages'][0]['speaker'], '玩家甲')
        self.assertEqual(parsed['messages'][0]['sent_at'], '2022-03-21 19:05:05')
        self.assertEqual(parsed['messages'][0]['qq_masked'], '11****22')


class MarkerParagraphTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.path = self.tmp / 'marker.docx'
        make_docx(self.path, (
            _p('【导入】')
            + _p('<kp> 你们来到旅馆。')
            + _p('“第二句话。”')
            + _p('【行动-医院】<kp> 医院门口。')
            + _p('<阿藤春树> 我走进去。')
            + _p('鬼rd7。<黑泽朔彦> 拿了瓶开喝。')
            + _p('——————')
            + _p('。log off')
            + _p('<骰子> 1D7=7')
        ))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_markers_chapters_and_continuations(self):
        parsed = parse_docx(self.path)
        self.assertEqual(
            [c['title'] for c in parsed['chapters']],
            ['【导入】', '【行动-医院】', '第1段'],
        )
        msgs = [(m['chapter_seq'], m['speaker'], m['content'], m['msg_type']) for m in parsed['messages']]
        self.assertEqual(
            msgs,
            [
                (0, 'KP', '你们来到旅馆。\n“第二句话。”', 'rp'),
                (1, 'KP', '医院门口。', 'rp'),
                (1, '阿藤春树', '我走进去。\n鬼rd7。', 'rp'),
                (1, '黑泽朔彦', '拿了瓶开喝。', 'rp'),
                (2, '骰子', '1D7=7', 'rp'),
            ],
        )


class DocxImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.logs = self.tmp / 'logs'
        (self.logs / '团B').mkdir(parents=True)
        make_docx(self.logs / '团B' / '第一场.docx', TABLE_BODY)
        (self.logs / '团B' / '~$临时.docx').write_bytes(b'lock')
        self.client = create_app(logs_dir=self.logs, db_path=self.tmp / 'test.db').test_client()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_docx_imported_and_exported(self):
        campaigns = self.client.get('/api/campaigns').get_json()
        self.assertEqual({c['name']: c['doc_count'] for c in campaigns}, {'团B': 1})
        cid = campaigns[0]['id']
        doc_id = self.client.get(f'/api/campaigns/{cid}/documents').get_json()[0]['id']
        data = self.client.get(f'/api/documents/{doc_id}/messages').get_json()
        self.assertEqual(data['total'], 4)
        self.assertIsNone(data['items'][0]['sent_at'])
        body = self.client.get(f'/api/documents/{doc_id}/export?format=txt').get_data(as_text=True)
        self.assertIn('张三 [场外]', body)
        self.assertIn('KP\n欢迎来到旅馆。', body)


class SignatureAndSeparatorTests(unittest.TestCase):
    def test_signature_removed_and_empty_sections_skipped(self):
        sig = '对于我来说，迄今为止的一切都很重要，包括事件最终无论好坏的结局。'
        tmp = Path(tempfile.mkdtemp())
        try:
            path = tmp / 'sig.docx'
            make_docx(path, '<w:tbl>'
                      + _row('阿藤春树', sig + 'D100=38/60 成功')
                      + _row('妙手画丹青', '——————')
                      + _row('阿藤春树', sig)
                      + _row('KP', '。log off')
                      + '</w:tbl>')
            parsed = parse_docx(path)
            self.assertEqual([c['title'] for c in parsed['chapters']], ['全文'])
            self.assertEqual(
                [(m['speaker'], m['content']) for m in parsed['messages']],
                [('阿藤春树', 'D100=38/60 成功')],
            )
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class LegacySchemaTests(unittest.TestCase):
    def test_legacy_messages_table_is_rebuilt(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            path = tmp / 'old.db'
            conn = sqlite3.connect(path)
            conn.executescript(
                'CREATE TABLE campaigns (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);'
                'CREATE TABLE documents (id INTEGER PRIMARY KEY, campaign_id INTEGER, title TEXT, '
                'source_key TEXT, file_hash TEXT, missing INTEGER DEFAULT 0, imported_at TEXT);'
                'CREATE TABLE chapters (id INTEGER PRIMARY KEY, document_id INTEGER, seq INTEGER, title TEXT);'
                'CREATE TABLE messages (id INTEGER PRIMARY KEY, document_id INTEGER, chapter_id INTEGER, '
                'seq INTEGER, speaker TEXT NOT NULL, qq_masked TEXT NOT NULL, sent_at TEXT NOT NULL, '
                "msg_type TEXT, content TEXT);"
            )
            conn.close()
            db.init_db(path)
            conn = db.connect(path)
            cols = {r['name']: r['notnull'] for r in conn.execute('PRAGMA table_info(messages)')}
            conn.close()
            self.assertEqual(cols['sent_at'], 0)
            self.assertEqual(cols['qq_masked'], 0)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    unittest.main()
