import shutil
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_DIR))

from app import create_app  # noqa: E402
from log_parser import mask_qq, parse_text  # noqa: E402

SAMPLE = """KP(99998888) 2022/03/21 19:00:00
开场白
KP(99998888) 2022/03/21 19:00:30
.log on 第一幕
玩家甲(11112222) 2022/03/21 19:01:00
我推开门。
（场外：等下）
第一章 雨夜
玩家甲(11112222) 2022/03/21 19:05:05
我看向窗外
KP(99998888) 2022/03/21 19:06:00
.log off
玩家乙(33334444) 2022/03/21 19:07:00
(场外闲聊)
系统消息(10000) 2022/03/21 19:08:00
玩家甲撤回了一条消息
"""


class ParserTests(unittest.TestCase):
    def test_messages_and_types(self):
        parsed = parse_text(SAMPLE)
        summary = [(m['speaker'], m['content'], m['msg_type']) for m in parsed['messages']]
        self.assertEqual(
            summary,
            [
                ('KP', '开场白', 'ooc'),
                ('玩家甲', '我推开门。\n（场外：等下）', 'rp'),
                ('玩家甲', '我看向窗外', 'rp'),
                ('玩家乙', '(场外闲聊)', 'ooc'),
            ],
        )

    def test_chapters_and_chapter_seq(self):
        parsed = parse_text(SAMPLE)
        self.assertEqual([c['title'] for c in parsed['chapters']], ['全文', '第一章 雨夜'])
        self.assertEqual([m['chapter_seq'] for m in parsed['messages']], [0, 0, 1, 1])

    def test_no_heading_single_default_chapter(self):
        parsed = parse_text('A(12345) 2022/01/01 10:00:00\nhi\n')
        self.assertEqual(parsed['chapters'], [{'seq': 0, 'title': '全文'}])
        self.assertEqual(parsed['messages'][0]['msg_type'], 'ooc')

    def test_qq_is_masked_and_raw_not_kept(self):
        parsed = parse_text(SAMPLE)
        for m in parsed['messages']:
            self.assertNotIn('11112222', str(m))
            self.assertNotIn('qq', m)
        self.assertEqual(mask_qq('11112222'), '11****22')
        self.assertEqual(parsed['messages'][1]['qq_masked'], '11****22')

    def test_control_and_system_messages_dropped(self):
        contents = [m['content'] for m in parse_text(SAMPLE)['messages']]
        self.assertFalse(any('.log' in c for c in contents))
        self.assertFalse(any('撤回' in c for c in contents))


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.logs = self.tmp / 'logs'
        (self.logs / '团A').mkdir(parents=True)
        (self.logs / '团A' / '第一场.txt').write_bytes(SAMPLE.encode('utf-8-sig'))
        (self.logs / '根目录.txt').write_bytes(SAMPLE.encode('utf-8'))
        self.app = create_app(logs_dir=self.logs, db_path=self.tmp / 'test.db')
        self.client = self.app.test_client()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _doc_id(self, campaign_name, title):
        campaigns = self.client.get('/api/campaigns').get_json()
        cid = next(c['id'] for c in campaigns if c['name'] == campaign_name)
        docs = self.client.get(f'/api/campaigns/{cid}/documents').get_json()
        return next(d['id'] for d in docs if d['title'] == title)

    def test_campaigns_and_documents(self):
        names = {c['name']: c['doc_count'] for c in self.client.get('/api/campaigns').get_json()}
        self.assertEqual(names, {'团A': 1, '未分组': 1})
        doc_id = self._doc_id('团A', '第一场')
        detail = self.client.get(f'/api/documents/{doc_id}').get_json()
        self.assertEqual(detail['campaign'], '团A')
        self.assertEqual([c['title'] for c in detail['chapters']], ['全文', '第一章 雨夜'])

    def test_message_filters(self):
        doc_id = self._doc_id('团A', '第一场')
        rp = self.client.get(f'/api/documents/{doc_id}/messages?type=rp').get_json()
        self.assertEqual(rp['total'], 2)
        spk = self.client.get(f'/api/documents/{doc_id}/messages?speaker=玩家乙').get_json()
        self.assertEqual(spk['total'], 1)
        kw = self.client.get(f'/api/documents/{doc_id}/messages?q=窗外').get_json()
        self.assertEqual(kw['total'], 1)
        detail = self.client.get(f'/api/documents/{doc_id}').get_json()
        chapter = detail['chapters'][1]['id']
        ch = self.client.get(f'/api/documents/{doc_id}/messages?chapter={chapter}').get_json()
        self.assertEqual(ch['total'], 2)

    def test_export_txt_and_md(self):
        doc_id = self._doc_id('团A', '第一场')
        txt = self.client.get(f'/api/documents/{doc_id}/export?format=txt')
        self.assertEqual(txt.status_code, 200)
        body = txt.get_data(as_text=True)
        self.assertIn('[场外]', body)
        self.assertIn('=== 第一章 雨夜 ===', body)
        self.assertNotIn('11112222', body)
        md = self.client.get(f'/api/documents/{doc_id}/export?format=md').get_data(as_text=True)
        self.assertIn('## 第一章 雨夜', md)

    def test_rescan_is_incremental_and_marks_missing(self):
        stats = self.client.post('/api/rescan').get_json()
        self.assertEqual((stats['added'], stats['updated'], stats['unchanged']), (0, 0, 2))
        (self.logs / '根目录.txt').unlink()
        stats = self.client.post('/api/rescan').get_json()
        self.assertEqual(stats['missing'], 1)
        missing = self.client.get('/api/campaigns').get_json()
        self.assertEqual({c['name']: c['doc_count'] for c in missing}['未分组'], 0)


if __name__ == '__main__':
    unittest.main()
