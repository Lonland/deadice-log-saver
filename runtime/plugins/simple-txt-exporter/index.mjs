import express from 'express';
import { createServer } from 'http';
import { promises as fs } from 'fs';
import path from 'path';

const PORT = Number(process.env.SIMPLE_TXT_EXPORTER_PORT || 40777);
const GROUP_CHAT_TYPE = 2;
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 5000;
const EXPORT_ROOT = path.join(
  process.env.USERPROFILE || process.env.HOME || process.cwd(),
  '.simple-txt-exporter',
  'exports'
);

let server = null;
let coreRef = null;

function createLogger(core) {
  const logger = core?.context?.logger;
  return {
    log: (...args) => (logger?.log ? logger.log(...args) : console.log('[SimpleTXT]', ...args)),
    warn: (...args) => (logger?.logWarn ? logger.logWarn(...args) : console.warn('[SimpleTXT]', ...args)),
    error: (...args) => (logger?.logError ? logger.logError(...args) : console.error('[SimpleTXT]', ...args))
  };
}

function normalizeCore(rawCore) {
  return rawCore;
}

function normalizePluginArgs(arg0, arg1, arg2, arg3) {
  const ctx = arg0 && typeof arg0 === 'object' ? arg0 : {};
  const nested = ctx._ctx || ctx.ctx || {};
  return {
    core: ctx.core || nested.core || ctx.instance?.core || nested.instance?.core || arg0,
    obContext: ctx.obContext || nested.obContext || ctx.oneBot || nested.oneBot || arg1,
    actions: ctx.actions || nested.actions || arg2,
    instance: ctx.instance || nested.instance || arg3
  };
}

function safeFileName(input) {
  return String(input || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'unknown';
}

function parseDateMillis(value, fallback) {
  if (!value) return fallback;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function msgTimeMillis(message) {
  const raw = Number(message?.msgTime || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw < 1e12 ? raw * 1000 : raw;
}

function formatDateTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'unknown-time';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function senderName(message) {
  return (
    message?.sendMemberName ||
    message?.sendRemarkName ||
    message?.sendNickName ||
    message?.senderUin ||
    message?.senderUid ||
    '未知用户'
  );
}

function senderId(message) {
  return message?.senderUin || message?.senderUid || '';
}

function textFromElement(element) {
  if (!element || typeof element !== 'object') return '';
  if (element.textElement?.content) return element.textElement.content;
  if (element.faceElement) return `[表情:${element.faceElement.faceText || element.faceElement.faceIndex || ''}]`;
  if (element.picElement) return `[图片:${element.picElement.fileName || element.picElement.md5HexStr || ''}]`;
  if (element.pttElement) return `[语音]`;
  if (element.videoElement) return `[视频:${element.videoElement.fileName || ''}]`;
  if (element.fileElement) return `[文件:${element.fileElement.fileName || ''}]`;
  if (element.replyElement) return `[回复]`;
  if (element.marketFaceElement) return `[表情:${element.marketFaceElement.faceName || '超级表情'}]`;
  if (element.grayTipElement) {
    return element.grayTipElement.content || element.grayTipElement.wording || '[系统消息]';
  }
  if (element.arkElement) return '[卡片消息]';
  if (element.multiForwardMsgElement) return '[合并转发]';
  return '';
}

function messageText(message) {
  const parts = (message?.elements || []).map(textFromElement).filter(Boolean);
  return parts.join('').trim() || '[无文本内容]';
}

function isSystemMessage(message) {
  if (!message) return true;
  if (Number(message.msgType) === 5) return true;

  const elements = message.elements || [];
  if (elements.length === 0) return false;
  return elements.every((element) => element?.grayTipElement || Number(element?.elementType) === 8);
}

function hasImageContent(message) {
  return (message?.elements || []).some((element) => !!element?.picElement);
}

function hasFileContent(message) {
  return (message?.elements || []).some((element) => !!element?.fileElement);
}

function normalizeFilters(options = {}) {
  return {
    removeSystem: options.removeSystem !== false,
    removeImage: options.removeImage === true,
    removeFile: options.removeFile === true
  };
}

function shouldKeepMessage(message, filters) {
  if (filters.removeSystem && isSystemMessage(message)) return false;
  if (filters.removeImage && hasImageContent(message)) return false;
  if (filters.removeFile && hasFileContent(message)) return false;
  return true;
}

function filterExportMessages(messages, filters) {
  return messages.filter((message) => shouldKeepMessage(message, filters));
}

function renderTxt(group, messages, filters = normalizeFilters()) {
  const lines = [];
  const visibleMessages = filterExportMessages(messages, filters);

  for (const message of visibleMessages) {
    const id = senderId(message);
    const name = senderName(message);
    const label = id ? `${name}(${id})` : name;
    lines.push(`${label} ${formatDateTime(msgTimeMillis(message))}`);
    lines.push(messageText(message));
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

function countVisibleMessages(messages, filters = normalizeFilters()) {
  return filterExportMessages(messages, filters).length;
}

function excelRows(messages, includeGroupCode = false, filters = normalizeFilters()) {
  return filterExportMessages(messages, filters)
    .map((message) => {
      const row = [
        formatDateTime(msgTimeMillis(message)),
        senderId(message),
        senderName(message),
        messageText(message)
      ];
      return includeGroupCode ? [message.__exportGroupCode || '', ...row] : row;
    });
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index) {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function renderSheetXml(rows, includeGroupCode = false) {
  const header = includeGroupCode ? ['群号', '时间', 'QQ号', '名字', '内容'] : ['时间', 'QQ号', '名字', '内容'];
  const allRows = [header, ...rows];
  const rowXml = allRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, colIndex) => {
      const cellRef = `${columnName(colIndex)}${rowNumber}`;
      return `<c r="${cellRef}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');

  const lastColumn = columnName(header.length - 1);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastColumn}${allRows.length}"/>
  <cols>
    ${includeGroupCode ? '<col min="1" max="1" width="16" customWidth="1"/>' : ''}
    <col min="${includeGroupCode ? 2 : 1}" max="${includeGroupCode ? 2 : 1}" width="22" customWidth="1"/>
    <col min="${includeGroupCode ? 3 : 2}" max="${includeGroupCode ? 3 : 2}" width="16" customWidth="1"/>
    <col min="${includeGroupCode ? 4 : 3}" max="${includeGroupCode ? 4 : 3}" width="18" customWidth="1"/>
    <col min="${includeGroupCode ? 5 : 4}" max="${includeGroupCode ? 5 : 4}" width="80" customWidth="1"/>
  </cols>
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = dosDateTime();

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

function renderXlsx(messages, includeGroupCode = false, filters = normalizeFilters()) {
  const rows = excelRows(messages, includeGroupCode, filters);
  return createZip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="聊天记录" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
    },
    {
      name: 'xl/styles.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: renderSheetXml(rows, includeGroupCode)
    }
  ]);
}

async function listGroups(core) {
  const groups = await core.apis.GroupApi.getGroups(false);
  return (groups || [])
    .map((group) => ({
      groupCode: String(group.groupCode || ''),
      name: group.groupName || `群聊 ${group.groupCode}`,
      memberCount: group.memberCount || 0
    }))
    .filter((group) => group.groupCode)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

async function fetchGroupMessages(core, groupCode, options) {
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const maxMessages = Math.max(1, Math.min(Number(options.maxMessages) || 50000, 500000));
  const startTime = parseDateMillis(options.startTime, 0);
  const endTime = parseDateMillis(options.endTime, Date.now());
  const peer = { chatType: GROUP_CHAT_TYPE, peerUid: String(groupCode), guildId: '' };
  const collected = [];
  let cursorMsgId = '';
  let done = false;

  while (!done && collected.length < maxMessages) {
    const result = cursorMsgId
      ? await core.apis.MsgApi.getMsgHistory(peer, cursorMsgId, batchSize, true)
      : await core.apis.MsgApi.getAioFirstViewLatestMsgs(peer, batchSize);
    const batch = result?.msgList || [];
    if (batch.length === 0) break;

    let earliest = batch[0];
    for (const message of batch) {
      const ts = msgTimeMillis(message);
      if (ts >= startTime && ts <= endTime) {
        collected.push(message);
      }
      if (ts && ts < startTime) {
        done = true;
      }
      if (msgTimeMillis(message) < msgTimeMillis(earliest)) {
        earliest = message;
      }
    }

    if (!earliest?.msgId || earliest.msgId === cursorMsgId) break;
    cursorMsgId = earliest.msgId;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }

  return collected
    .sort((a, b) => msgTimeMillis(a) - msgTimeMillis(b))
    .slice(0, maxMessages);
}

function normalizeGroupCodes(body) {
  const rawCodes = Array.isArray(body?.groupCodes)
    ? body.groupCodes
    : body?.groupCode
      ? [body.groupCode]
      : [];
  return Array.from(new Set(
    rawCodes
      .map((code) => String(code || '').trim())
      .filter(Boolean)
  ));
}

async function fetchMergedGroupMessages(core, groupCodes, groups, options) {
  const merged = [];
  const groupMap = new Map(groups.map((group) => [group.groupCode, group]));

  for (const groupCode of groupCodes) {
    const group = groupMap.get(groupCode) || { groupCode, name: `群聊 ${groupCode}` };
    const messages = await fetchGroupMessages(core, groupCode, options);
    for (const message of messages) {
      merged.push({
        ...message,
        __exportGroupCode: groupCode,
        __exportGroupName: group.name
      });
    }
  }

  return merged.sort((a, b) => msgTimeMillis(a) - msgTimeMillis(b));
}

function htmlPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>轻量 TXT 群聊导出</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #202124; background: #f6f7f9; }
    main { max-width: 760px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 26px; margin: 0 0 24px; }
    section { background: #fff; border: 1px solid #dfe3ea; border-radius: 8px; padding: 20px; }
    label { display: block; font-size: 14px; font-weight: 650; margin: 14px 0 6px; }
    select, input { width: 100%; box-sizing: border-box; border: 1px solid #c9ced8; border-radius: 6px; padding: 10px 12px; font-size: 15px; background: #fff; }
    input[type="checkbox"] { width: auto; margin: 0 8px 0 0; }
    .filters { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 14px; margin-top: 8px; }
    .filters label { display: flex; align-items: center; margin: 0; font-weight: 500; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button { margin-top: 18px; border: 0; border-radius: 6px; background: #1f6feb; color: white; padding: 11px 16px; font-size: 15px; cursor: pointer; }
    button:disabled { background: #9aa4b2; cursor: wait; }
    #status { margin-top: 14px; white-space: pre-wrap; line-height: 1.5; }
    a { color: #1f6feb; }
    @media (max-width: 620px) { .row, .filters { grid-template-columns: 1fr; } main { padding: 22px 14px; } }
  </style>
</head>
<body>
  <main>
    <h1>轻量 TXT 群聊导出</h1>
    <section>
      <label for="groupSearch">搜索或输入群号/群名</label>
      <input id="groupSearch" type="text" placeholder="输入群名或群号过滤；多个群号可用逗号或空格分隔">
      <label for="group">群聊（可多选）</label>
      <select id="group" multiple size="8"><option>正在读取群列表...</option></select>
      <div class="row">
        <div>
          <label for="start">开始时间</label>
          <input id="start" type="datetime-local">
        </div>
        <div>
          <label for="end">结束时间</label>
          <input id="end" type="datetime-local">
        </div>
      </div>
      <div class="row">
        <div>
          <label for="limit">每群最多消息数</label>
          <input id="limit" type="number" min="1" max="500000" value="50000">
        </div>
        <div>
          <label for="batch">每批读取</label>
          <input id="batch" type="number" min="1" max="5000" value="1000">
        </div>
      </div>
      <label for="format">导出格式</label>
      <select id="format">
        <option value="txt">TXT</option>
        <option value="xlsx">Excel（.xlsx）</option>
      </select>
      <label>过滤选项</label>
      <div class="filters">
        <label><input id="removeSystem" type="checkbox" checked>去除系统记录</label>
        <label><input id="removeImage" type="checkbox">去除图片记录</label>
        <label><input id="removeFile" type="checkbox">去除文件记录</label>
      </div>
      <button id="export">导出</button>
      <div id="status"></div>
    </section>
  </main>
  <script>
    const groupEl = document.getElementById('group');
    const groupSearchEl = document.getElementById('groupSearch');
    const statusEl = document.getElementById('status');
    const buttonEl = document.getElementById('export');
    let allGroups = [];

    async function api(path, options) {
      const res = await fetch(path, options);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || '请求失败');
      return body.data;
    }

    function groupLabel(group) {
      return group.memberCount ? group.name + ' (' + group.groupCode + ', ' + group.memberCount + '人)' : group.name + ' (' + group.groupCode + ')';
    }

    function renderGroupOptions(groups) {
      groupEl.innerHTML = '';
      for (const group of groups) {
        const opt = document.createElement('option');
        opt.value = group.groupCode;
        opt.textContent = groupLabel(group);
        groupEl.appendChild(opt);
      }
      if (groups.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '没有匹配的群聊，可直接输入群号后导出';
        groupEl.appendChild(opt);
      }
    }

    function filterGroups() {
      const keyword = groupSearchEl.value.trim().toLowerCase();
      if (!keyword) {
        renderGroupOptions(allGroups);
        statusEl.textContent = allGroups.length ? '选择群聊和时间范围后即可导出。' : '没有读取到群聊。';
        return;
      }

      const matched = allGroups.filter(group => {
        return group.groupCode.includes(keyword) || group.name.toLowerCase().includes(keyword);
      });
      renderGroupOptions(matched);
      statusEl.textContent = matched.length ? '已按输入内容过滤群聊。' : '没有匹配的群聊；如果输入的是完整群号，可以直接导出。';
    }

    function resolveGroupCodes() {
      const input = groupSearchEl.value.trim();
      const manualCodes = input
        .split(/[,\s，、;；]+/)
        .map(item => item.trim())
        .filter(item => /^\d{5,}$/.test(item));
      const selectedCodes = Array.from(groupEl.selectedOptions || [])
        .map(option => option.value)
        .filter(Boolean);
      return Array.from(new Set([...manualCodes, ...selectedCodes]));
    }

    async function loadGroups() {
      try {
        allGroups = await api('/api/groups');
        renderGroupOptions(allGroups);
        statusEl.textContent = allGroups.length ? '选择群聊和时间范围后即可导出。' : '没有读取到群聊。';
      } catch (error) {
        groupEl.innerHTML = '<option>群列表读取失败</option>';
        statusEl.textContent = error.message;
      }
    }

    groupSearchEl.addEventListener('input', filterGroups);

    buttonEl.addEventListener('click', async () => {
      buttonEl.disabled = true;
      statusEl.textContent = '正在导出，历史消息多时需要等一会儿...';
      try {
        const groupCodes = resolveGroupCodes();
        if (groupCodes.length === 0) throw new Error('请选择至少一个群聊，或输入完整群号');
        const data = await api('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            groupCodes,
            startTime: document.getElementById('start').value,
            endTime: document.getElementById('end').value,
            maxMessages: document.getElementById('limit').value,
            batchSize: document.getElementById('batch').value,
            format: document.getElementById('format').value,
            removeSystem: document.getElementById('removeSystem').checked,
            removeImage: document.getElementById('removeImage').checked,
            removeFile: document.getElementById('removeFile').checked
          })
        });
        statusEl.innerHTML = '导出完成：' + data.messageCount + ' 条消息<br><a href="' + data.downloadUrl + '">打开导出文件</a><br>保存位置：' + data.filePath;
      } catch (error) {
        statusEl.textContent = error.message;
      } finally {
        buttonEl.disabled = false;
      }
    });

    loadGroups();
  </script>
</body>
</html>`;
}

async function startServer(core, logger) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/', (_req, res) => {
    res.type('html').send(htmlPage());
  });

  app.get('/api/groups', async (_req, res) => {
    try {
      res.json({ success: true, data: await listGroups(core) });
    } catch (error) {
      logger.error('读取群列表失败:', error);
      res.status(500).json({ success: false, error: error?.message || String(error) });
    }
  });

  app.post('/api/export', async (req, res) => {
    try {
      const groupCodes = normalizeGroupCodes(req.body);
      if (groupCodes.length === 0) {
        return res.status(400).json({ success: false, error: '请选择至少一个群聊' });
      }

      const groups = await listGroups(core);
      const messages = await fetchMergedGroupMessages(core, groupCodes, groups, req.body || {});
      const format = req.body?.format === 'xlsx' ? 'xlsx' : 'txt';
      const filters = normalizeFilters(req.body || {});
      const isMultiGroup = groupCodes.length > 1;
      const content = format === 'xlsx'
        ? renderXlsx(messages, isMultiGroup, filters)
        : renderTxt({ groupCode: groupCodes.join('_'), name: isMultiGroup ? '多群合并' : `群聊 ${groupCodes[0]}` }, messages, filters);
      await fs.mkdir(EXPORT_ROOT, { recursive: true });

      const exportName = isMultiGroup ? `多群合并_${groupCodes.length}群` : `${safeFileName((groups.find((item) => item.groupCode === groupCodes[0]) || {}).name || '群聊')}_${groupCodes[0]}`;
      const fileName = `${safeFileName(exportName)}_${Date.now()}.${format}`;
      const filePath = path.join(EXPORT_ROOT, fileName);
      await fs.writeFile(filePath, content);

      res.json({
        success: true,
        data: {
          messageCount: countVisibleMessages(messages, filters),
          fileName,
          filePath,
          downloadUrl: `/api/download?file=${encodeURIComponent(fileName)}`
        }
      });
    } catch (error) {
      logger.error('导出失败:', error);
      res.status(500).json({ success: false, error: error?.message || String(error) });
    }
  });

  async function handleDownload(req, res) {
    try {
      const rawFileName = String(req.query.file || req.params.fileName || '');
      const fileName = path.basename(rawFileName);
      if (!fileName) {
        return res.status(400).type('text/plain').send('Missing file name. Please export again from the page.');
      }

      const exportRoot = path.resolve(EXPORT_ROOT);
      const targetPath = path.resolve(exportRoot, fileName);
      if (targetPath !== exportRoot && !targetPath.startsWith(exportRoot + path.sep)) {
        return res.status(400).type('text/plain').send('Invalid file name.');
      }

      try {
        await fs.access(targetPath);
      } catch {
        return res.status(404).type('text/plain').send(`Export file not found: ${fileName}\nPlease export again from the page.`);
      }

      res.download(targetPath, fileName, (error) => {
        if (error && !res.headersSent) {
          res.status(500).type('text/plain').send(`Download failed: ${error.message || error}`);
        }
      });
    } catch (error) {
      res.status(500).type('text/plain').send(`Download failed: ${error?.message || error}`);
    }
  }

  app.get('/api/download', handleDownload);
  app.get('/api/download/:fileName', handleDownload);

  server = createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  logger.log(`轻量 TXT 群聊导出已启动: http://localhost:${PORT}/`);
}

export async function plugin_init(arg0, arg1, arg2, arg3) {
  const { core } = normalizePluginArgs(arg0, arg1, arg2, arg3);
  if (!core) {
    console.error('[SimpleTXT] NapCat core is missing');
    return;
  }

  coreRef = normalizeCore(core);
  const logger = createLogger(coreRef);
  try {
    await startServer(coreRef, logger);
  } catch (error) {
    logger.error('启动失败:', error);
  }
}

export async function plugin_cleanup() {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  coreRef = null;
}


