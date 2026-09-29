import express from 'express';
import { createServer } from 'http';
import { promises as fs, readdirSync, unlinkSync } from 'fs';
import path from 'path';

const PORT = Number(process.env.SIMPLE_TXT_EXPORTER_PORT || 40777);
const GROUP_CHAT_TYPE = 2;
const DEFAULT_BATCH_SIZE = 1000;
const MAX_BATCH_SIZE = 5000;
const USER_HOME = process.env.USERPROFILE || process.env.HOME || process.cwd();
const DEFAULT_EXPORT_ROOT = path.join(USER_HOME, 'Downloads', 'QQ跑团Log导出器');
const LEGACY_EXPORT_ROOT = path.join(USER_HOME, '.simple-txt-exporter', 'exports');
const QQ_CHAT_EXPORTER_DIR = path.join(USER_HOME, '.qq-chat-exporter');

let server = null;
let coreRef = null;
let cleanupHooksRegistered = false;
let sensitiveArtifactsCleaned = false;
let loginStatusState = {
  isOnline: false,
  isInvalid: false,
  label: '未知',
  detail: ''
};
const exportedFiles = new Map();
const exportJobs = new Map();

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

function updateLoginStatus(patch) {
  loginStatusState = {
    ...loginStatusState,
    ...patch
  };
}

function getRuntimeConfigDir() {
  return coreRef?.context?.pathWrapper?.configPath || '';
}

function isSensitiveUserArtifact(fileName) {
  return fileName === 'security.json' || fileName.endsWith('.jsonl');
}

function isSensitiveRuntimeArtifact(fileName) {
  return fileName === 'webui.json' || /^napcat_.*\.json$/i.test(fileName) || /^onebot11_.*\.json$/i.test(fileName);
}

function collectSensitiveArtifacts() {
  const targets = new Set();

  try {
    for (const fileName of readdirSync(QQ_CHAT_EXPORTER_DIR)) {
      if (isSensitiveUserArtifact(fileName)) {
        targets.add(path.join(QQ_CHAT_EXPORTER_DIR, fileName));
      }
    }
  } catch {
    // Ignore missing or unreadable user data folders.
  }

  const runtimeConfigDir = getRuntimeConfigDir();
  if (runtimeConfigDir) {
    try {
      for (const fileName of readdirSync(runtimeConfigDir)) {
        if (isSensitiveRuntimeArtifact(fileName)) {
          targets.add(path.join(runtimeConfigDir, fileName));
        }
      }
    } catch {
      // Ignore missing or unreadable runtime config folders.
    }
  }

  return [...targets];
}

async function removeSensitiveArtifacts(logger) {
  if (sensitiveArtifactsCleaned) return [];

  const removed = [];
  for (const filePath of collectSensitiveArtifacts()) {
    try {
      await fs.unlink(filePath);
      removed.push(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger?.warn?.(`清理敏感文件失败: ${filePath}`, error);
      }
    }
  }

  sensitiveArtifactsCleaned = true;
  return removed;
}

function removeSensitiveArtifactsSync() {
  if (sensitiveArtifactsCleaned) return;

  for (const filePath of collectSensitiveArtifacts()) {
    try {
      unlinkSync(filePath);
    } catch {
      // Ignore missing or locked files during shutdown.
    }
  }

  sensitiveArtifactsCleaned = true;
}

function registerCleanupHooks() {
  if (cleanupHooksRegistered) return;
  cleanupHooksRegistered = true;

  process.once('exit', () => {
    removeSensitiveArtifactsSync();
  });

  const cleanupAndExit = (code) => {
    removeSensitiveArtifactsSync();
    process.exit(code);
  };

  process.once('SIGINT', () => cleanupAndExit(130));
  process.once('SIGTERM', () => cleanupAndExit(143));
}

function registerLoginStatusListeners(core, logger) {
  const session = core?.context?.session;
  const loginService = session?.getLoginService?.();
  const profileService = session?.getProfileService?.();
  const msgService = session?.getMsgService?.();

  if (!loginService && !profileService && !msgService) {
    return;
  }

  const loginListener = {
    onLoginConnected: () => {
      updateLoginStatus({ label: '登录服务已连接', detail: '' });
    },
    onLoginDisConnected: () => {
      updateLoginStatus({ isOnline: false, isInvalid: true, label: '登录连接已断开', detail: '当前账号可能已失效或网络已断开' });
    },
    onLogoutSucceed: () => {
      updateLoginStatus({ isOnline: false, isInvalid: true, label: '已退出登录', detail: 'QQ 已退出登录' });
    },
    onLogoutFailed: () => {
      updateLoginStatus({ label: '退出登录失败', detail: '退出动作未完成' });
    },
    onUserLoggedIn: (userId) => {
      updateLoginStatus({ label: `账号 ${userId} 已登录`, detail: '' });
    }
  };

  const profileListener = {
    onSelfStatusChanged: (info) => {
      if (info?.status === 20) {
        updateLoginStatus({ isOnline: false, isInvalid: true, label: '账号已离线', detail: '当前登录已失效或被挤下线' });
      } else {
        updateLoginStatus({ isOnline: true, isInvalid: false, label: '账号在线', detail: '' });
      }
    }
  };

  const msgListener = {
    onKickedOffLine: (info) => {
      const title = info?.tipsTitle || '账号被挤下线';
      const desc = info?.tipsDesc || '当前登录已失效';
      updateLoginStatus({ isOnline: false, isInvalid: true, label: title, detail: desc });
    }
  };

  try {
    loginService?.addKernelLoginListener?.(loginListener);
  } catch (error) {
    logger?.warn?.('注册登录状态监听失败', error);
  }

  try {
    profileService?.addKernelProfileListener?.(profileListener);
  } catch (error) {
    logger?.warn?.('注册资料状态监听失败', error);
  }

  try {
    msgService?.addKernelMsgListener?.(msgListener);
  } catch (error) {
    logger?.warn?.('注册消息状态监听失败', error);
  }

  updateLoginStatus({
    isOnline: !!core?.selfInfo?.online,
    isInvalid: !core?.selfInfo?.online,
    label: core?.selfInfo?.online ? '账号在线' : '账号离线',
    detail: core?.selfInfo?.online ? '' : '如果刚退出或被挤下线，页面会提示登录失效'
  });
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

function htmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function resolveOutputDir(input) {
  const raw = String(input || '').trim();
  if (!raw) return DEFAULT_EXPORT_ROOT;
  return path.resolve(raw.replace(/^~(?=$|[\\/])/, USER_HOME));
}

function createDownloadId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function withTimeout(promiseFactory, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    Promise.resolve()
      .then(promiseFactory)
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
}

function updateExportJob(jobId, patch) {
  const job = exportJobs.get(jobId);
  if (!job) return;
  exportJobs.set(jobId, {
    ...job,
    ...patch,
    updatedAt: Date.now()
  });
}

function getExportJob(jobId) {
  return exportJobs.get(jobId) || null;
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
  const modeAliases = {
    all: 'all',
    inside: 'inside_no_paren',
    outside: 'outside_all',
    inside_all: 'inside_all',
    inside_no_paren: 'inside_no_paren',
    outside_all: 'outside_all'
  };
  const logMode = modeAliases[options.logMode] || 'all';
  return {
    removeSystem: options.removeSystem !== false,
    removeImage: options.removeImage === true,
    removeFile: options.removeFile === true,
    logMode
  };
}

function normalizeLogCommandText(text) {
  return String(text || '')
    .trim()
    .replace(/^。/, '.')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function getLogCommand(message) {
  const text = normalizeLogCommandText(messageText(message));
  if (/^\.log\s+(new|on)(\s|$)/.test(text)) return 'start';
  if (/^\.log\s+(end|off)(\s|$)/.test(text)) return 'end';
  return '';
}

function isOutOfCharacterText(message) {
  const text = messageText(message).trimStart();
  return text.startsWith('(') || text.startsWith('（');
}

function annotateLogScenes(messages) {
  const insideByGroup = new Map();
  const annotated = [];

  for (const message of messages) {
    const groupKey = String(message.__exportGroupCode || message.peerUid || 'default');
    const inside = insideByGroup.get(groupKey) === true;
    const command = getLogCommand(message);
    if (command === 'start') {
      if (!inside) insideByGroup.set(groupKey, true);
      continue;
    }
    if (command === 'end') {
      if (inside) insideByGroup.set(groupKey, false);
      continue;
    }

    const currentInside = insideByGroup.get(groupKey) === true;
    const isOoc = currentInside && isOutOfCharacterText(message);
    annotated.push({
      ...message,
      __logInsideSegment: currentInside,
      __logOocByParen: isOoc,
      __logScene: currentInside && !isOoc ? 'inside' : 'outside'
    });
  }

  return annotated;
}

function shouldKeepMessage(message, filters) {
  if (filters.removeSystem && isSystemMessage(message)) return false;
  if (filters.removeImage && hasImageContent(message)) return false;
  if (filters.removeFile && hasFileContent(message)) return false;
  if (filters.logMode === 'inside_all' && !message.__logInsideSegment) return false;
  if (filters.logMode === 'inside_no_paren' && message.__logScene !== 'inside') return false;
  if (filters.logMode === 'outside_all' && message.__logScene !== 'outside') return false;
  return true;
}

function filterExportMessages(messages, filters) {
  return annotateLogScenes(messages).filter((message) => shouldKeepMessage(message, filters));
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

function messageSceneType(message) {
  if (message.__logInsideSegment && message.__logOocByParen) return '场内有括号';
  if (message.__logInsideSegment) return '场内无括号';
  return '场外消息';
}

function excelRows(messages, includeGroupCode = false, filters = normalizeFilters()) {
  return filterExportMessages(messages, filters)
    .map((message) => {
      const row = [
        formatDateTime(msgTimeMillis(message)),
        senderId(message),
        senderName(message),
        messageSceneType(message),
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
  const header = includeGroupCode
    ? ['群号', '时间', 'QQ号', '名字', '消息类型', '内容']
    : ['时间', 'QQ号', '名字', '消息类型', '内容'];
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
    <col min="${includeGroupCode ? 5 : 4}" max="${includeGroupCode ? 5 : 4}" width="16" customWidth="1"/>
    <col min="${includeGroupCode ? 6 : 5}" max="${includeGroupCode ? 6 : 5}" width="80" customWidth="1"/>
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

async function fetchGroupMessages(core, groupCode, options, onProgress, groupIndex, totalGroups) {
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE));
  const maxMessages = Math.max(1, Math.min(Number(options.maxMessages) || 50000, 500000));
  const startTime = parseDateMillis(options.startTime, 0);
  const endTime = parseDateMillis(options.endTime, Date.now());
  const peer = { chatType: GROUP_CHAT_TYPE, peerUid: String(groupCode), guildId: '' };
  const collected = [];
  let cursorMsgId = '';
  let done = false;
  let batchIndex = 0;
  const estimatedBatches = Math.max(1, Math.ceil(maxMessages / batchSize));

  while (!done && collected.length < maxMessages) {
    batchIndex += 1;
    const requestLabel = cursorMsgId ? `getMsgHistory(${groupCode}, ${cursorMsgId})` : `getAioFirstViewLatestMsgs(${groupCode})`;
    console.log(`[SimpleTXT] 开始请求消息批次`, { groupCode, batchIndex, batchSize, cursorMsgId: cursorMsgId || null, requestLabel });
    const requestFactory = () => (cursorMsgId
      ? core.apis.MsgApi.getMsgHistory(peer, cursorMsgId, batchSize, true)
      : core.apis.MsgApi.getAioFirstViewLatestMsgs(peer, batchSize));
    const result = await withTimeout(
      requestFactory,
      20000,
      `群聊 ${groupCode} 的消息接口在第 ${batchIndex} 批超时，可能是网络、权限或消息服务暂时无响应`
    );
    console.log(`[SimpleTXT] 消息批次返回`, { groupCode, batchIndex, batchLength: result?.msgList?.length || 0, cursorMsgId: cursorMsgId || null });
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

    if (totalGroups && onProgress) {
      const basePercent = ((groupIndex - 1) / totalGroups) * 100;
      const batchPercent = (batchIndex / estimatedBatches) * (100 / totalGroups);
      onProgress({
        percent: clampPercent(basePercent + batchPercent),
        detail: `正在读取群聊 ${groupCode}（第 ${batchIndex}/${estimatedBatches} 批）`
      });
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

async function fetchMergedGroupMessages(core, groupCodes, groups, options, onProgress) {
  const merged = [];
  const groupMap = new Map(groups.map((group) => [group.groupCode, group]));
  const totalGroups = Math.max(groupCodes.length, 1);

  for (const [index, groupCode] of groupCodes.entries()) {
    const group = groupMap.get(groupCode) || { groupCode, name: `群聊 ${groupCode}` };
    console.log(`[SimpleTXT] 开始处理群聊`, { groupCode, groupName: group.name, index: index + 1, totalGroups });
    onProgress?.({
      percent: clampPercent((index / totalGroups) * 100),
      detail: `正在读取 ${group.name}`
    });
    const messages = await fetchGroupMessages(core, groupCode, options, onProgress, index + 1, totalGroups);
    for (const message of messages) {
      merged.push({
        ...message,
        __exportGroupCode: groupCode,
        __exportGroupName: group.name
      });
    }
  }

  onProgress?.({
    percent: 95,
    detail: '正在整理导出内容'
  });

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
    input[type="checkbox"], input[type="radio"] { width: auto; margin: 0 8px 0 0; }
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
      <label for="outputDir">保存位置</label>
      <input id="outputDir" type="text" value="${htmlAttr(DEFAULT_EXPORT_ROOT)}">
      <label>场景范围</label>
      <div class="filters">
        <label><input name="logMode" type="radio" value="all" checked>全部消息</label>
        <label><input name="logMode" type="radio" value="inside_all">全部场内</label>
        <label><input name="logMode" type="radio" value="inside_no_paren">场内无括号消息</label>
        <label><input name="logMode" type="radio" value="outside_all">全部场外</label>
      </div>
      <label>过滤选项</label>
      <div class="filters">
        <label><input id="removeSystem" type="checkbox" checked>去除系统记录</label>
        <label><input id="removeImage" type="checkbox">去除图片记录</label>
        <label><input id="removeFile" type="checkbox">去除文件记录</label>
      </div>
      <label>登录状态</label>
      <div id="loginState" style="padding:10px 12px;border:1px solid #dfe3ea;border-radius:6px;background:#f8fafc;line-height:1.5;">正在获取状态...</div>
      <div id="progressWrap" style="display:none;margin-top:16px;">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">
          <span id="progressLabel">准备开始</span>
          <span id="progressPercent">0%</span>
        </div>
        <div style="width:100%;height:10px;border-radius:999px;background:#e9edf4;overflow:hidden;">
          <div id="progressBar" style="width:0%;height:100%;background:#1f6feb;transition:width .2s ease;"></div>
        </div>
      </div>
      <button id="export">导出</button>
      <div id="status" style="margin-top:14px;white-space:pre-wrap;line-height:1.5;"></div>
    </section>
  </main>
  <script>
    const groupEl = document.getElementById('group');
    const groupSearchEl = document.getElementById('groupSearch');
    const statusEl = document.getElementById('status');
    const buttonEl = document.getElementById('export');
    const loginStateEl = document.getElementById('loginState');
    const progressWrapEl = document.getElementById('progressWrap');
    const progressLabelEl = document.getElementById('progressLabel');
    const progressPercentEl = document.getElementById('progressPercent');
    const progressBarEl = document.getElementById('progressBar');
    let allGroups = [];
    let exportPollTimer = null;
    let currentJobId = '';

    async function api(path, options) {
      const res = await fetch(path, options);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || '请求失败');
      return body.data;
    }

    function renderLoginState(state) {
      if (!state) {
        loginStateEl.textContent = '状态未知';
        return;
      }
      const statusText = state.isOnline ? '在线' : (state.isInvalid ? '登录失效 / 已离线' : '离线');
      const detailText = state.detail ? '<br>' + state.detail : '';
      loginStateEl.innerHTML = '<strong>' + statusText + '</strong><br>' + state.label + detailText;
    }

    function setExportProgress({ visible, label, percent, message, isError }) {
      if (visible) {
        progressWrapEl.style.display = 'block';
      } else {
        progressWrapEl.style.display = 'none';
      }
      if (label !== undefined) progressLabelEl.textContent = label;
      if (percent !== undefined) {
        progressPercentEl.textContent = percent + '%';
        progressBarEl.style.width = percent + '%';
      }
      if (message !== undefined) {
        statusEl.innerHTML = isError ? '<span style="color:#c62828;">' + message + '</span>' : message;
      }
    }

    function stopExportPolling() {
      if (exportPollTimer) {
        clearTimeout(exportPollTimer);
        exportPollTimer = null;
      }
    }

    async function pollExportStatus(jobId) {
      if (!jobId) return;
      try {
        const job = await api('/api/export/status/' + encodeURIComponent(jobId));
        if (job?.status === 'done') {
          stopExportPolling();
          setExportProgress({ visible: false, message: '导出完成：' + job.messageCount + ' 条消息<br><a href="' + job.downloadUrl + '">打开导出文件</a><br>保存位置：' + job.filePath, percent: 100 });
          buttonEl.disabled = false;
          currentJobId = '';
          return;
        }
        if (job?.status === 'error') {
          stopExportPolling();
          setExportProgress({ visible: true, label: '导出失败', percent: job.percent || 0, message: job.error || '导出失败', isError: true });
          buttonEl.disabled = false;
          currentJobId = '';
          return;
        }
        setExportProgress({ visible: true, label: job?.message || '正在导出', percent: job?.percent || 0, message: job?.detail || '正在导出，请稍候…' });
        exportPollTimer = setTimeout(() => pollExportStatus(jobId), 1000);
      } catch (error) {
        stopExportPolling();
        setExportProgress({ visible: true, label: '状态获取失败', percent: 0, message: error.message, isError: true });
        buttonEl.disabled = false;
        currentJobId = '';
      }
    }

    async function refreshLoginState() {
      try {
        renderLoginState(await api('/api/status'));
      } catch (error) {
        loginStateEl.textContent = '状态读取失败：' + error.message;
      }
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
      stopExportPolling();
      buttonEl.disabled = true;
      setExportProgress({ visible: true, label: '准备开始', percent: 0, message: '正在提交导出任务…' });
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
            outputDir: document.getElementById('outputDir').value,
            logMode: document.querySelector('input[name="logMode"]:checked').value,
            removeSystem: document.getElementById('removeSystem').checked,
            removeImage: document.getElementById('removeImage').checked,
            removeFile: document.getElementById('removeFile').checked
          })
        });
        currentJobId = data.jobId || '';
        if (!currentJobId) throw new Error('导出任务未返回任务编号');
        setExportProgress({ visible: true, label: '已加入队列', percent: 0, message: '导出已经开始，正在读取消息…' });
        pollExportStatus(currentJobId);
      } catch (error) {
        setExportProgress({ visible: true, label: '导出失败', percent: 0, message: error.message, isError: true });
        buttonEl.disabled = false;
      }
    });

    refreshLoginState();
    setInterval(refreshLoginState, 5000);
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

  app.get('/api/status', (_req, res) => {
    res.json({
      success: true,
      data: loginStatusState
    });
  });

  app.post('/api/export', async (req, res) => {
    try {
      const groupCodes = normalizeGroupCodes(req.body);
      if (groupCodes.length === 0) {
        return res.status(400).json({ success: false, error: '请选择至少一个群聊' });
      }

      const jobId = createDownloadId();
      exportJobs.set(jobId, {
        id: jobId,
        status: 'queued',
        percent: 0,
        message: '已加入导出队列',
        detail: '正在准备导出任务…',
        error: '',
        filePath: '',
        fileName: '',
        downloadUrl: '',
        messageCount: 0,
        createdAt: Date.now()
      });

      (async () => {
        try {
          console.log(`[SimpleTXT] 导出任务开始`, { jobId, groupCodes });
          updateExportJob(jobId, { status: 'running', percent: 1, message: '开始导出', detail: '正在读取群聊列表…' });
          const groups = await listGroups(core);
          console.log(`[SimpleTXT] 群列表读取完成`, { jobId, groupCount: groups.length });
          const messages = await fetchMergedGroupMessages(core, groupCodes, groups, req.body || {}, (state) => {
            updateExportJob(jobId, {
              status: 'running',
              percent: state.percent || 0,
              message: state.detail || '正在导出',
              detail: state.detail || '正在导出'
            });
          });
          const format = req.body?.format === 'xlsx' ? 'xlsx' : 'txt';
          const filters = normalizeFilters(req.body || {});
          const isMultiGroup = groupCodes.length > 1;
          const content = format === 'xlsx'
            ? renderXlsx(messages, isMultiGroup, filters)
            : renderTxt({ groupCode: groupCodes.join('_'), name: isMultiGroup ? '多群合并' : `群聊 ${groupCodes[0]}` }, messages, filters);
          const outputDir = resolveOutputDir(req.body?.outputDir);
          console.log(`[SimpleTXT] 写出文件`, { jobId, outputDir, format, messageCount: countVisibleMessages(messages, filters) });
          await fs.mkdir(outputDir, { recursive: true });

          const exportName = isMultiGroup ? `多群合并_${groupCodes.length}群` : `${safeFileName((groups.find((item) => item.groupCode === groupCodes[0]) || {}).name || '群聊')}_${groupCodes[0]}`;
          const fileName = `${safeFileName(exportName)}_${Date.now()}.${format}`;
          const filePath = path.join(outputDir, fileName);
          await fs.writeFile(filePath, content);
          const downloadId = createDownloadId();
          exportedFiles.set(downloadId, { filePath, fileName });
          const messageCount = countVisibleMessages(messages, filters);

          console.log(`[SimpleTXT] 导出任务完成`, { jobId, fileName, filePath, messageCount });
          updateExportJob(jobId, {
            status: 'done',
            percent: 100,
            message: '导出完成',
            detail: `已导出 ${messageCount} 条消息`,
            error: '',
            filePath,
            fileName,
            downloadUrl: `/api/download?id=${encodeURIComponent(downloadId)}`,
            messageCount
          });
        } catch (error) {
          logger.error('导出失败:', error);
          console.error(`[SimpleTXT] 导出任务失败`, { jobId, error: error?.message || String(error) });
          updateExportJob(jobId, {
            status: 'error',
            percent: 0,
            message: '导出失败',
            detail: error?.message || String(error),
            error: error?.message || String(error)
          });
        }
      })();

      res.json({
        success: true,
        data: {
          jobId,
          status: 'queued',
          message: '导出已开始',
          percent: 0
        }
      });
    } catch (error) {
      logger.error('提交导出失败:', error);
      res.status(500).json({ success: false, error: error?.message || String(error) });
    }
  });

  app.get('/api/export/status/:jobId', (req, res) => {
    const job = getExportJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: '导出任务不存在' });
    }
    res.json({ success: true, data: job });
  });

  async function handleDownload(req, res) {
    try {
      const id = String(req.query.id || '');
      let fileName = '';
      let targetPath = '';

      if (id && exportedFiles.has(id)) {
        const item = exportedFiles.get(id);
        fileName = item.fileName;
        targetPath = item.filePath;
      } else {
        const rawFileName = String(req.query.file || req.params.fileName || '');
        fileName = path.basename(rawFileName);
        if (!fileName) {
          return res.status(400).type('text/plain').send('Missing file name. Please export again from the page.');
        }

        const candidates = [
          path.join(resolveOutputDir(req.query.dir), fileName),
          path.join(DEFAULT_EXPORT_ROOT, fileName),
          path.join(LEGACY_EXPORT_ROOT, fileName)
        ];
        for (const candidate of candidates) {
          try {
            await fs.access(candidate);
            targetPath = candidate;
            break;
          } catch {
            // Try next candidate.
          }
        }
      }

      if (!targetPath) {
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
  registerCleanupHooks();
  registerLoginStatusListeners(coreRef, logger);
  try {
    await startServer(coreRef, logger);
  } catch (error) {
    logger.error('启动失败:', error);
  }
}

export async function plugin_cleanup() {
  const logger = createLogger(coreRef);
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
  await removeSensitiveArtifacts(logger);
  coreRef = null;
}








