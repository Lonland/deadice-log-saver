# 跑团日志网页

把 QQ跑团Log导出器 导出的 TXT 日志放到本地网页中浏览，支持多个团、每篇多章、场内/场外区分。

## 准备

```powershell
cd 跑团日志网页
pip install -r requirements.txt
```

## 放置日志

按“团名文件夹 / 文档.txt”组织，文件夹名即团名：

```txt
跑团日志网页/logs/
  团A/
    第一场.txt
    第二场.txt
  团B/
    某次跑团.txt
  根目录的txt会归入“未分组”
```

章节：日志中单独一行形如 `第一章 雨夜`、`第3幕` 的内容会被识别为章节标题（规则见 [log_parser.py](./log_parser.py) 中的 `CHAPTER_RE`）。没有章节标题的文档只有一个“全文”章节。

## 启动

```powershell
python app.py
```

浏览器打开 `http://127.0.0.1:5000/`。页面只绑定 `127.0.0.1`。

可选环境变量：`PORT`（默认 5000）、`LOGS_DIR`（默认 `logs/`）、`DB_PATH`（默认 `data/logs.db`）。

点击页面顶部的“重新扫描”可导入新增或修改过的 TXT；已改动的文件会重新解析，已删除的文件在页面中标注为“文件已移除”，数据不会被删除。

## 解析规则

- 消息头格式：`名字(QQ号) yyyy/MM/dd HH:mm:ss`，与导出器一致。
- QQ 号入库前打码（如 `11****22`），原始 QQ 号不保存。
- 场内/场外规则与导出器一致：`.log on/new` 到 `.log off/end` 之间为场内；场外消息，或以 `(`/`（` 开头的发言，标记为“场外”。
- 控制指令（`.log ...`）与系统消息（撤回、入群提示等）不入库。

## 测试

```powershell
python -m unittest tests.test_log_parser -v
```

## 文件说明

- `app.py`：Flask 应用与 API。
- `log_parser.py`：TXT 解析。
- `importer.py`：扫描 `logs/` 并增量导入。
- `db.py`：SQLite 表结构与连接。
- `templates/index.html`、`static/`：页面。
