import hashlib
from pathlib import Path

from log_parser import decode_bytes, parse_text

UNGROUPED_CAMPAIGN = '未分组'


def _campaign_id(conn, name: str) -> int:
    conn.execute('INSERT OR IGNORE INTO campaigns (name) VALUES (?)', (name,))
    return conn.execute('SELECT id FROM campaigns WHERE name = ?', (name,)).fetchone()['id']


def _clear_document(conn, document_id: int) -> None:
    conn.execute('DELETE FROM messages WHERE document_id = ?', (document_id,))
    conn.execute('DELETE FROM chapters WHERE document_id = ?', (document_id,))


def _write_parsed(conn, document_id: int, parsed: dict) -> None:
    chapter_ids = {}
    for chapter in parsed['chapters']:
        cur = conn.execute(
            'INSERT INTO chapters (document_id, seq, title) VALUES (?, ?, ?)',
            (document_id, chapter['seq'], chapter['title']),
        )
        chapter_ids[chapter['seq']] = cur.lastrowid
    for seq, message in enumerate(parsed['messages']):
        conn.execute(
            'INSERT INTO messages (document_id, chapter_id, seq, speaker, qq_masked, sent_at, msg_type, content) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            (
                document_id,
                chapter_ids[message['chapter_seq']],
                seq,
                message['speaker'],
                message['qq_masked'],
                message['sent_at'],
                message['msg_type'],
                message['content'],
            ),
        )


def scan_logs(conn, logs_dir: Path) -> dict:
    """扫描 logs/<团名>/*.txt（根目录的 txt 归入“未分组”），按文件内容 hash 增量导入。"""
    stats = {'added': 0, 'updated': 0, 'unchanged': 0, 'missing': 0, 'errors': []}
    logs_dir = Path(logs_dir)
    logs_dir.mkdir(parents=True, exist_ok=True)

    files = []
    for entry in sorted(logs_dir.iterdir()):
        if entry.is_dir():
            files.extend((entry.name, f) for f in sorted(entry.glob('*.txt')))
        elif entry.is_file() and entry.suffix.lower() == '.txt':
            files.append((UNGROUPED_CAMPAIGN, entry))

    seen_keys = set()
    for campaign_name, path in files:
        key = path.relative_to(logs_dir).as_posix()
        seen_keys.add(key)
        try:
            data = path.read_bytes()
            digest = hashlib.sha256(data).hexdigest()
            row = conn.execute(
                'SELECT id, file_hash FROM documents WHERE source_key = ?', (key,)
            ).fetchone()
            if row and row['file_hash'] == digest:
                conn.execute('UPDATE documents SET missing = 0 WHERE id = ?', (row['id'],))
                conn.commit()
                stats['unchanged'] += 1
                continue

            parsed = parse_text(decode_bytes(data))
            campaign_id = _campaign_id(conn, campaign_name)
            if row:
                _clear_document(conn, row['id'])
                conn.execute(
                    'UPDATE documents SET campaign_id = ?, title = ?, file_hash = ?, missing = 0, '
                    "imported_at = datetime('now', 'localtime') WHERE id = ?",
                    (campaign_id, path.stem, digest, row['id']),
                )
                document_id = row['id']
                stats['updated'] += 1
            else:
                cur = conn.execute(
                    'INSERT INTO documents (campaign_id, title, source_key, file_hash) VALUES (?, ?, ?, ?)',
                    (campaign_id, path.stem, key, digest),
                )
                document_id = cur.lastrowid
                stats['added'] += 1
            _write_parsed(conn, document_id, parsed)
            conn.commit()
        except Exception as exc:  # 单个文件失败不影响其他文件
            conn.rollback()
            stats['errors'].append({'file': key, 'error': str(exc)})

    for row in conn.execute('SELECT id, source_key FROM documents WHERE missing = 0').fetchall():
        if row['source_key'] not in seen_keys:
            conn.execute('UPDATE documents SET missing = 1 WHERE id = ?', (row['id'],))
            stats['missing'] += 1
    conn.commit()
    return stats
