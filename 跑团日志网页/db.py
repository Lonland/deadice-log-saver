import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    title TEXT NOT NULL,
    source_key TEXT NOT NULL UNIQUE,
    file_hash TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    seq INTEGER NOT NULL,
    title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    chapter_id INTEGER NOT NULL REFERENCES chapters(id),
    seq INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    qq_masked TEXT,
    sent_at TEXT,
    msg_type TEXT NOT NULL CHECK (msg_type IN ('rp', 'ooc')),
    content TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_campaign ON documents(campaign_id);
CREATE INDEX IF NOT EXISTS idx_chapters_document ON chapters(document_id);
CREATE INDEX IF NOT EXISTS idx_messages_document_seq ON messages(document_id, seq);
"""


def connect(db_path) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def _has_legacy_schema(conn) -> bool:
    cols = {row['name']: row for row in conn.execute('PRAGMA table_info(messages)')}
    return bool(cols) and bool(cols['sent_at']['notnull'] or cols['qq_masked']['notnull'])


def init_db(db_path) -> None:
    conn = connect(db_path)
    try:
        if _has_legacy_schema(conn):
            # 旧表结构要求时间和 QQ 非空。数据均来自源文件，清空后 rescan 会重新导入。
            conn.executescript(
                'DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS chapters; '
                'DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS campaigns;'
            )
        conn.executescript(SCHEMA)
        conn.commit()
    finally:
        conn.close()
