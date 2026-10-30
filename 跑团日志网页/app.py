import os
from contextlib import closing
from pathlib import Path
from urllib.parse import quote

from flask import Flask, Response, abort, jsonify, render_template, request

import db
from importer import scan_logs

BASE_DIR = Path(__file__).resolve().parent
MAX_PAGE = 2000
EXPORT_TYPES = {'rp', 'ooc'}


def _message_where(args, document_id: int):
    where = ['m.document_id = ?']
    params = [document_id]
    chapter_id = args.get('chapter', type=int)
    if chapter_id:
        where.append('m.chapter_id = ?')
        params.append(chapter_id)
    msg_type = args.get('type', 'all')
    if msg_type in EXPORT_TYPES:
        where.append('m.msg_type = ?')
        params.append(msg_type)
    speaker = args.get('speaker', '').strip()
    if speaker:
        where.append('m.speaker = ?')
        params.append(speaker)
    keyword = args.get('q', '').strip()
    if keyword:
        where.append('instr(m.content, ?) > 0')
        params.append(keyword)
    return ' AND '.join(where), params


def _message_header(row) -> str:
    head = row['speaker']
    if row['qq_masked']:
        head += f"({row['qq_masked']})"
    if row['sent_at']:
        head += f" {row['sent_at']}"
    return head


def _export_text(doc, rows, fmt: str) -> str:
    lines = []
    if fmt == 'md':
        lines.append(f"# {doc['title']}")
        lines.append('')
        lines.append(f"> 团：{doc['campaign']}")
        lines.append('')
    else:
        lines.append(doc['title'])
        lines.append(f"团：{doc['campaign']}")
        lines.append('')
    current_chapter = None
    for row in rows:
        if row['chapter_title'] != current_chapter:
            current_chapter = row['chapter_title']
            lines.append(f'## {current_chapter}' if fmt == 'md' else f'=== {current_chapter} ===')
            lines.append('')
        tag = ' [场外]' if row['msg_type'] == 'ooc' else ''
        header = _message_header(row) + tag
        lines.append(f'**{header}**' if fmt == 'md' else header)
        lines.append(row['content'])
        lines.append('')
    return '\n'.join(lines)


def create_app(logs_dir=None, db_path=None) -> Flask:
    app = Flask(__name__)
    app.config['LOGS_DIR'] = Path(logs_dir or os.environ.get('LOGS_DIR') or BASE_DIR / 'logs')
    app.config['DB_PATH'] = Path(db_path or os.environ.get('DB_PATH') or BASE_DIR / 'data' / 'logs.db')
    db.init_db(app.config['DB_PATH'])
    with closing(db.connect(app.config['DB_PATH'])) as conn:
        scan_logs(conn, app.config['LOGS_DIR'])

    def get_conn():
        return closing(db.connect(app.config['DB_PATH']))

    @app.get('/')
    def index():
        return render_template('index.html')

    @app.get('/api/campaigns')
    def campaigns():
        with get_conn() as conn:
            rows = conn.execute(
                'SELECT c.id, c.name, COUNT(d.id) AS doc_count FROM campaigns c '
                'LEFT JOIN documents d ON d.campaign_id = c.id AND d.missing = 0 '
                'GROUP BY c.id ORDER BY c.name'
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get('/api/campaigns/<int:campaign_id>/documents')
    def campaign_documents(campaign_id):
        with get_conn() as conn:
            rows = conn.execute(
                'SELECT id, title, missing FROM documents WHERE campaign_id = ? ORDER BY title',
                (campaign_id,),
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get('/api/documents/<int:document_id>')
    def document_detail(document_id):
        with get_conn() as conn:
            doc = conn.execute(
                'SELECT d.id, d.title, d.missing, c.name AS campaign FROM documents d '
                'JOIN campaigns c ON c.id = d.campaign_id WHERE d.id = ?',
                (document_id,),
            ).fetchone()
            if doc is None:
                abort(404)
            chapters = conn.execute(
                'SELECT ch.id, ch.seq, ch.title, COUNT(m.id) AS message_count FROM chapters ch '
                'LEFT JOIN messages m ON m.chapter_id = ch.id '
                'WHERE ch.document_id = ? GROUP BY ch.id ORDER BY ch.seq',
                (document_id,),
            ).fetchall()
        result = dict(doc)
        result['chapters'] = [dict(c) for c in chapters]
        return jsonify(result)

    @app.get('/api/documents/<int:document_id>/speakers')
    def document_speakers(document_id):
        with get_conn() as conn:
            rows = conn.execute(
                'SELECT speaker, COUNT(*) AS count FROM messages WHERE document_id = ? '
                'GROUP BY speaker ORDER BY count DESC',
                (document_id,),
            ).fetchall()
        return jsonify([dict(r) for r in rows])

    @app.get('/api/documents/<int:document_id>/messages')
    def document_messages(document_id):
        where, params = _message_where(request.args, document_id)
        offset = max(request.args.get('offset', 0, type=int), 0)
        limit = min(max(request.args.get('limit', 500, type=int), 1), MAX_PAGE)
        with get_conn() as conn:
            total = conn.execute(f'SELECT COUNT(*) FROM messages m WHERE {where}', params).fetchone()[0]
            rows = conn.execute(
                'SELECT m.id, m.chapter_id, m.speaker, m.qq_masked, m.sent_at, m.msg_type, m.content '
                f'FROM messages m WHERE {where} ORDER BY m.seq LIMIT ? OFFSET ?',
                [*params, limit, offset],
            ).fetchall()
        return jsonify({'total': total, 'items': [dict(r) for r in rows]})

    @app.get('/api/documents/<int:document_id>/export')
    def document_export(document_id):
        fmt = request.args.get('format', 'txt')
        if fmt not in ('txt', 'md'):
            abort(400)
        where, params = _message_where(request.args, document_id)
        with get_conn() as conn:
            doc = conn.execute(
                'SELECT d.title, c.name AS campaign FROM documents d '
                'JOIN campaigns c ON c.id = d.campaign_id WHERE d.id = ?',
                (document_id,),
            ).fetchone()
            if doc is None:
                abort(404)
            rows = conn.execute(
                'SELECT m.speaker, m.qq_masked, m.sent_at, m.msg_type, m.content, ch.title AS chapter_title '
                'FROM messages m JOIN chapters ch ON ch.id = m.chapter_id '
                f'WHERE {where} ORDER BY m.seq',
                params,
            ).fetchall()
        body = _export_text(doc, rows, fmt)
        filename = f"{doc['campaign']}_{doc['title']}.{fmt}"
        return Response(
            body.encode('utf-8'),
            mimetype='text/markdown' if fmt == 'md' else 'text/plain',
            headers={
                'Content-Disposition': f"attachment; filename*=UTF-8''{quote(filename)}",
            },
        )

    @app.post('/api/rescan')
    def rescan():
        with get_conn() as conn:
            stats = scan_logs(conn, app.config['LOGS_DIR'])
        return jsonify(stats)

    return app


if __name__ == '__main__':
    create_app().run(host='127.0.0.1', port=int(os.environ.get('PORT', 5000)), debug=False)
