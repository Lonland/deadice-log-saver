(() => {
  const PAGE_SIZE = 500;
  const state = {
    doc: null,
    chapterId: '',
    type: 'all',
    speaker: '',
    q: '',
    offset: 0,
    total: 0,
    loading: false,
    requestId: 0,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function api(path, options) {
    const res = await fetch(path, options);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  async function loadTree() {
    const tree = $('tree');
    tree.textContent = '';
    const campaigns = await api('/api/campaigns');
    if (campaigns.length === 0) {
      tree.append(el('p', 'muted', '没有日志。请把 TXT 放入 logs/ 文件夹后点击“重新扫描”。'));
      return;
    }
    for (const campaign of campaigns) {
      const details = el('details', 'campaign');
      const summary = el('summary', null, campaign.name);
      summary.append(el('span', 'count', `(${campaign.doc_count})`));
      details.append(summary);
      const list = el('ul', 'doc-list');
      details.append(list);
      details.addEventListener('toggle', async () => {
        if (details.open && !details.dataset.loaded) {
          details.dataset.loaded = '1';
          await renderDocs(campaign.id, list);
        }
      });
      tree.append(details);
    }
  }

  async function renderDocs(campaignId, list) {
    const docs = await api(`/api/campaigns/${campaignId}/documents`);
    list.textContent = '';
    for (const doc of docs) {
      const item = el('li', 'doc-item');
      item.dataset.docId = doc.id;
      const button = el('button', doc.missing ? 'missing' : null, doc.title + (doc.missing ? '（文件已移除）' : ''));
      button.type = 'button';
      button.addEventListener('click', () => openDoc(doc.id));
      item.append(button);
      list.append(item);
    }
  }

  function highlightDoc(docId) {
    document.querySelectorAll('.doc-item').forEach((node) => {
      node.classList.toggle('active', Number(node.dataset.docId) === docId);
      const old = node.querySelector('.chapter-list');
      if (old) old.remove();
    });
  }

  async function openDoc(docId) {
    const detail = await api(`/api/documents/${docId}`);
    state.doc = detail;
    state.chapterId = '';
    state.type = 'all';
    state.speaker = '';
    state.q = '';
    $('type-select').value = 'all';
    $('search-input').value = '';
    $('chapter-select').textContent = '';
    $('chapter-select').append(new Option('全部章节', ''));
    for (const ch of detail.chapters) {
      $('chapter-select').append(new Option(`${ch.title}（${ch.message_count}）`, ch.id));
    }

    highlightDoc(docId);
    renderChapterNav(detail);

    $('empty').hidden = true;
    $('viewer').hidden = false;
    $('doc-title').textContent = detail.title + (detail.missing ? '（源文件已移除）' : '');
    $('doc-meta').textContent = `团：${detail.campaign}`;

    const speakers = await api(`/api/documents/${docId}/speakers`);
    const speakerSelect = $('speaker-select');
    speakerSelect.textContent = '';
    speakerSelect.append(new Option('全部角色', ''));
    for (const s of speakers) {
      speakerSelect.append(new Option(`${s.speaker}（${s.count}）`, s.speaker));
    }
    await reloadMessages();
  }

  function renderChapterNav(detail) {
    const item = document.querySelector(`.doc-item[data-doc-id="${detail.id}"]`);
    if (!item || detail.chapters.length === 0) return;
    const list = el('ul', 'chapter-list');
    const allBtn = el('li', 'chapter-item active');
    allBtn.dataset.chapterId = '';
    const all = el('button', null, '全部章节');
    all.type = 'button';
    all.addEventListener('click', () => selectChapter(''));
    allBtn.append(all);
    list.append(allBtn);
    for (const ch of detail.chapters) {
      const li = el('li', 'chapter-item');
      li.dataset.chapterId = ch.id;
      const btn = el('button', null, `${ch.title}（${ch.message_count}）`);
      btn.type = 'button';
      btn.addEventListener('click', () => selectChapter(String(ch.id)));
      li.append(btn);
      list.append(li);
    }
    item.append(list);
  }

  function selectChapter(chapterId) {
    state.chapterId = chapterId;
    $('chapter-select').value = chapterId;
    document.querySelectorAll('.chapter-item').forEach((node) => {
      node.classList.toggle('active', node.dataset.chapterId === chapterId);
    });
    reloadMessages();
  }

  function buildQuery(extra = {}) {
    const params = new URLSearchParams();
    if (state.chapterId) params.set('chapter', state.chapterId);
    if (state.type !== 'all') params.set('type', state.type);
    if (state.speaker) params.set('speaker', state.speaker);
    if (state.q) params.set('q', state.q);
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
  }

  async function reloadMessages() {
    if (!state.doc) return;
    const requestId = ++state.requestId;
    state.offset = 0;
    const container = $('messages');
    container.textContent = '';
    delete container.dataset.lastChapter;
    await fetchPage(requestId);
  }

  async function fetchPage(requestId) {
    if (!state.doc) return;
    const docId = state.doc.id;
    state.loading = true;
    const data = await api(`/api/documents/${docId}/messages?${buildQuery({ offset: state.offset, limit: PAGE_SIZE })}`);
    if (requestId !== state.requestId) return;
    state.loading = false;
    state.total = data.total;
    renderMessages(data.items);
    state.offset += data.items.length;
    $('count').textContent = `显示 ${state.offset} / ${state.total} 条`;
    $('more-btn').hidden = state.offset >= state.total;
  }

  function renderMessages(items) {
    const container = $('messages');
    const chapterTitles = new Map(state.doc.chapters.map((c) => [c.id, c.title]));
    let lastChapter = container.dataset.lastChapter ? Number(container.dataset.lastChapter) : null;
    for (const m of items) {
      if (!state.chapterId && m.chapter_id !== lastChapter) {
        lastChapter = m.chapter_id;
        container.append(el('div', 'chapter-heading', chapterTitles.get(m.chapter_id) || ''));
      }
      const node = el('div', `msg ${m.msg_type}`);
      const head = el('div', 'msg-head');
      head.append(el('span', 'msg-speaker', m.speaker));
      head.append(el('span', 'msg-qq', `(${m.qq_masked})`));
      head.append(el('span', 'msg-time', m.sent_at));
      if (m.msg_type === 'ooc') head.append(el('span', 'msg-tag', '场外'));
      node.append(head);
      node.append(el('div', 'msg-body', m.content));
      container.append(node);
    }
    container.dataset.lastChapter = lastChapter === null ? '' : String(lastChapter);
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function bindControls() {
    $('chapter-select').addEventListener('change', (e) => selectChapter(e.target.value));
    $('type-select').addEventListener('change', (e) => { state.type = e.target.value; reloadMessages(); });
    $('speaker-select').addEventListener('change', (e) => { state.speaker = e.target.value; reloadMessages(); });
    $('search-input').addEventListener('input', debounce((e) => { state.q = e.target.value.trim(); reloadMessages(); }, 300));
    $('time-toggle').addEventListener('change', (e) => { $('messages').classList.toggle('hide-time', !e.target.checked); });
    $('more-btn').addEventListener('click', () => { if (!state.loading) fetchPage(state.requestId); });
    $('export-btn').addEventListener('click', () => {
      if (!state.doc) return;
      const format = $('export-format').value;
      window.location.href = `/api/documents/${state.doc.id}/export?${buildQuery({ format })}`;
    });
    $('rescan-btn').addEventListener('click', async () => {
      setStatus('扫描中…');
      try {
        const stats = await api('/api/rescan', { method: 'POST' });
        setStatus(`新增 ${stats.added}，更新 ${stats.updated}，未变 ${stats.unchanged}，缺失 ${stats.missing}，错误 ${stats.errors.length}`);
        await loadTree();
      } catch (err) {
        setStatus('扫描失败：' + err.message);
      }
    });
  }

  bindControls();
  loadTree().then(() => setStatus('')).catch((err) => setStatus('加载失败：' + err.message));
})();
