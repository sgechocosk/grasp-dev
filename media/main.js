// Webview 側のUI。依存ライブラリなしの素のDOM操作。
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendEl = $('send');
  const statusEl = $('status');
  const MAX_SHOWN_OUTPUT = 8000;

  let state = { hasKey: true, busy: false, permissionMode: 'default', hasWorkspace: true };
  let settingsOpen = false;
  let streaming = null; // { el, text, scheduled }
  const toolEls = new Map();

  // ---------- markdown ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function inline(text) {
    return text.split(/(`[^`\n]+`)/).map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    }).join('');
  }

  const isBlockStart = (l) => /^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s)/.test(l);
  const isTableSep = (l) => l !== undefined && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function renderMarkdown(src) {
    const lines = src.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      } else if (!line.trim()) {
        i++;
      } else if (/^#{1,6}\s/.test(line)) {
        const m = line.match(/^(#{1,6})\s+(.*)$/);
        out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
        i++;
      } else if (line.includes('|') && isTableSep(lines[i + 1])) {
        let html = '<table><thead><tr>' + cells(line).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          html += '<tr>' + cells(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
        }
        out.push(html + '</tbody></table>');
      } else if (/^\s*([-*+]|\d+[.)])\s/.test(line)) {
        while (i < lines.length && /^\s*([-*+]|\d+[.)])\s/.test(lines[i])) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
          let body = m[3];
          i++;
          // 字下げされた継続行は同じ項目に含める
          while (i < lines.length && lines[i].trim() && /^\s+/.test(lines[i]) && !isBlockStart(lines[i])) body += ' ' + lines[i++].trim();
          const bullet = /\d/.test(m[2]) ? esc(m[2]) : '•';
          out.push(`<div class="li" style="margin-left:${Math.floor(m[1].length / 2) * 1.2}em"><span class="bullet">${bullet}</span><span>${inline(body)}</span></div>`);
        }
      } else if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${quote.map(inline).join('<br>')}</blockquote>`);
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1]))) para.push(lines[i++]);
        out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      }
    }
    return out.join('');
  }

  // ---------- rendering ----------
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
  }
  function append(node) {
    const stick = nearBottom();
    messagesEl.appendChild(node);
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    return node;
  }

  function addUser(text) {
    const e = el('div', 'msg user');
    e.textContent = text;
    append(e);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function addAssistant(text) {
    return append(el('div', 'msg assistant', renderMarkdown(text)));
  }
  function addNote(kind, text) {
    const e = el('div', 'note ' + kind);
    e.textContent = text;
    append(e);
  }

  function clip(s) {
    s = String(s ?? '');
    return s.length > MAX_SHOWN_OUTPUT ? s.slice(0, MAX_SHOWN_OUTPUT) + `\n… (残り ${s.length - MAX_SHOWN_OUTPUT} 文字は省略)` : s;
  }
  function diffHtml(oldStr, newStr) {
    const rows = (s, sign, cls) => (s ? String(s).split('\n').map((l) => `<div class="${cls}">${sign} ${esc(l)}</div>`).join('') : '');
    return `<div class="diff">${rows(oldStr, '-', 'del')}${rows(newStr, '+', 'add')}</div>`;
  }
  function toolInputHtml(name, input) {
    input = input && typeof input === 'object' ? input : {};
    if (name === 'Edit') return diffHtml(input.old_string, clip(input.new_string));
    if (name === 'Write') return diffHtml('', clip(input.content));
    if (name === 'Bash') return `<pre class="cmd">$ ${esc(input.command ?? '')}</pre>`;
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      return '<div class="todos">' + input.todos.map((t) => {
        const mark = t.status === 'completed' ? '☑' : t.status === 'in_progress' ? '▶' : '☐';
        return `<div class="todo ${esc(t.status)}">${mark} ${esc(t.content)}</div>`;
      }).join('') + '</div>';
    }
    if (name === 'Read' || name === 'Glob' || name === 'Grep') return '';
    return `<pre>${esc(JSON.stringify(input, null, 2))}</pre>`;
  }

  function addTool(item) {
    const box = el('details', 'tool');
    box.dataset.name = item.name;
    const hasPath = ['Read', 'Edit', 'Write'].includes(item.name) && item.input && item.input.file_path;
    const sum = el('summary', '', `<span class="dot"></span><span class="tname">${esc(item.name)}</span><span class="tsum${hasPath ? ' link' : ''}">${esc(item.summary || '')}</span>`);
    if (hasPath) {
      sum.querySelector('.tsum').addEventListener('click', (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openFile', path: item.input.file_path });
      });
    }
    box.appendChild(sum);
    const body = el('div', 'tbody', toolInputHtml(item.name, item.input));
    box.appendChild(body);
    if (item.name === 'TodoWrite' || item.name === 'Edit' || item.name === 'Write') box.open = true;
    toolEls.set(item.id, box);
    append(box);
    if (item.done) finishTool(item.id, item.output, item.isError);
    return box;
  }

  function finishTool(id, output, isError) {
    const box = toolEls.get(id);
    if (!box) return;
    box.classList.add(isError ? 'error' : 'ok');
    box.querySelector('.perm')?.remove();
    // TodoWrite の結果はモデル向けの定型文なので表示しない
    if (output && !box.querySelector('.tout') && !(box.dataset.name === 'TodoWrite' && !isError)) {
      const pre = el('pre', 'tout');
      pre.textContent = clip(output);
      box.querySelector('.tbody').appendChild(pre);
    }
  }

  function showPermission(toolCallId, key) {
    const box = toolEls.get(toolCallId);
    if (!box) return;
    box.open = true;
    const perm = el('div', 'perm', `<div class="ptext">このツールの実行を許可しますか?</div>`);
    const respond = (behavior) => {
      perm.remove();
      updateStatus();
      vscode.postMessage({ type: 'permission_response', toolCallId, decision: { behavior } });
    };
    const btn = (label, behavior, cls) => {
      const b = el('button', cls);
      b.textContent = label;
      b.addEventListener('click', () => respond(behavior));
      perm.appendChild(b);
    };
    btn('許可', 'allow', 'primary');
    btn(`このセッション中は常に許可: ${key}`, 'always', 'secondary');
    btn('拒否', 'deny', 'secondary');
    box.appendChild(perm);
    box.scrollIntoView({ block: 'nearest' });
    updateStatus();
  }

  function renderItem(item) {
    if (item.kind === 'user') addUser(item.text);
    else if (item.kind === 'assistant') addAssistant(item.text);
    else if (item.kind === 'tool') addTool(item);
    else addNote(item.kind, item.text);
  }

  function flushStreaming() {
    if (!streaming) return;
    streaming.scheduled = false;
    const stick = nearBottom();
    streaming.el.innerHTML = renderMarkdown(streaming.text);
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function onEvent(ev) {
    switch (ev.type) {
      case 'assistant_start':
        streaming = null;
        break;
      case 'text_delta':
        if (!streaming) streaming = { el: addAssistant(''), text: '', scheduled: false };
        streaming.text += ev.delta;
        if (!streaming.scheduled) {
          streaming.scheduled = true;
          requestAnimationFrame(flushStreaming);
        }
        break;
      case 'assistant_end':
        if (streaming) {
          streaming.text = ev.text || streaming.text;
          flushStreaming();
        } else if (ev.text) addAssistant(ev.text);
        streaming = null;
        break;
      case 'tool_start':
        addTool({ ...ev, done: false });
        break;
      case 'tool_end':
        finishTool(ev.id, ev.output, ev.isError);
        break;
      case 'usage':
        $('meta').textContent = `${(ev.usage.inputTokens / 1000).toFixed(1)}k tokens`;
        break;
      case 'info':
      case 'error':
        addNote(ev.type, ev.message);
        break;
      case 'aborted':
        addNote('info', '中断しました。');
        break;
    }
    updateStatus();
  }

  function updateStatus() {
    const waiting = !!document.querySelector('.perm');
    statusEl.hidden = !state.busy;
    $('statusText').textContent = waiting ? '許可を待っています…' : '作業中…';
  }

  function applyState(s) {
    state = s;
    // キー未設定のあいだは設定パネルを常に表示する
    $('settings').hidden = s.hasKey && !settingsOpen;
    $('keyStatus').textContent = s.hasKey ? '(設定済み)' : '(未設定)';
    $('keyInput').placeholder = s.hasKey ? '新しいキーを入力すると置き換えます' : 'sk-...';
    $('settingsClose').hidden = !s.hasKey;
    sendEl.textContent = s.busy ? '停止' : '送信';
    sendEl.classList.toggle('stop', s.busy);
    $('mode').value = s.permissionMode;
    inputEl.disabled = !s.hasKey || !s.hasWorkspace;
    inputEl.placeholder = !s.hasWorkspace
      ? 'フォルダを開くと利用できます'
      : '質問や実装の指示を入力… (Shift+Enterで改行)';
    updateStatus();
  }

  // ---------- input ----------
  function submit() {
    if (state.busy) return vscode.postMessage({ type: 'stop' });
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', text });
    inputEl.value = '';
    autosize();
  }
  function autosize() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
  }
  inputEl.addEventListener('input', autosize);
  inputEl.addEventListener('keydown', (e) => {
    // IME変換確定のEnterでは送信しない
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      if (!state.busy) submit();
    }
  });
  sendEl.addEventListener('click', submit);
  $('mode').addEventListener('change', (e) => vscode.postMessage({ type: 'setMode', mode: e.target.value }));
  const saveKey = () => {
    const key = $('keyInput').value.trim();
    if (!key) return;
    vscode.postMessage({ type: 'setApiKey', key });
    $('keyInput').value = '';
    settingsOpen = false;
  };
  $('settingsClose').addEventListener('click', () => { settingsOpen = false; applyState(state); });
  $('keySave').addEventListener('click', saveKey);
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });

  window.addEventListener('message', ({ data: m }) => {
    switch (m.type) {
      case 'init':
        messagesEl.innerHTML = '';
        toolEls.clear();
        streaming = null;
        $('meta').textContent = '';
        m.transcript.forEach(renderItem);
        applyState(m.state);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        break;
      case 'state': applyState(m.state); break;
      case 'toggle_settings':
        settingsOpen = !settingsOpen;
        applyState(state);
        if (settingsOpen) $('keyInput').focus();
        break;
      case 'user': addUser(m.text); break;
      case 'event': onEvent(m.event); break;
      case 'permission_request': showPermission(m.toolCallId, m.key); break;
      case 'permission_cancel': toolEls.get(m.toolCallId)?.querySelector('.perm')?.remove(); updateStatus(); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
