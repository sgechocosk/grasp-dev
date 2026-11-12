// Webview 側のUI。依存ライブラリなしの素のDOM操作。
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendEl = $('send');
  const statusEl = $('status');
  const MAX_SHOWN_OUTPUT = 8000;

  let state = { hasKey: true, busy: false, permissionMode: 'acceptEdits', hasWorkspace: true, understand: true, level: 'intermediate', holding: false };
  let statusNote = ''; // ホストから届いた進み具合の文
  let progress = null; // 理解モードの実行中に出す、ツールの回数
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
  let container = null; // 作業の記録など、まとめて入れる先 (無ければ会話の末尾)
  function append(node) {
    const stick = nearBottom();
    (container || messagesEl).appendChild(node);
    if (stick && !container) messagesEl.scrollTop = messagesEl.scrollHeight;
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
    else if (item.kind === 'walk') onWalk(item.message);
    else if (item.kind === 'record') addRecord(item.items);
    else addNote(item.kind, item.text);
  }

  /** 手順をたどり終えてから見せる、作業の記録 (折りたたみ) */
  function addRecord(items) {
    const box = el('details', 'record');
    box.appendChild(el('summary', '', `作業の記録(${items.length}件)`));
    const body = el('div', 'rbody');
    box.appendChild(body);
    append(box);
    container = body;
    try {
      // 実行中に出したコマンドのカードとは別に、出力つきで並べ直す
      items.forEach((item) => (item.kind === 'tool' ? addTool({ ...item, id: 'rec:' + item.id }) : renderItem(item)));
    } finally {
      container = null;
    }
  }

  // ---------- たどる手順 ----------
  const BLANK = '___BLANK___';
  const VERDICT = { changed: '変更した', checked: '読んだうえで変更なし', unseen: '未確認' };
  const walks = new Map(); // walk の番号 → { el, kind, steps: Map(index → stepState) }

  function fileLink(path, line, text) {
    const a = el('span', 'flink');
    a.textContent = text || (line ? `${path}:${line}` : path);
    a.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path, line }));
    return a;
  }
  function section(title) {
    const sec = el('div', 'wsec');
    if (title) sec.appendChild(el('h4', '', esc(title)));
    return sec;
  }
  function textBlock(cls, text) {
    const d = el('div', 'wtext ' + (cls || ''));
    d.textContent = text;
    return d;
  }
  function diffBlock(d) {
    const box = el('div', 'wdiff');
    const head = el('div', 'dpath');
    head.appendChild(fileLink(d.path));
    if (d.created) head.appendChild(el('span', 'tag', '新規'));
    if (d.deleted) head.appendChild(el('span', 'tag', '削除'));
    box.appendChild(head);
    const rows = String(d.diff || '').split('\n').map((l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('…') ? 'skip' : '';
      return `<div class="${cls}">${esc(l) || '&nbsp;'}</div>`;
    });
    box.appendChild(el('div', 'diff', rows.join('')));
    return box;
  }

  /** 空欄つきのコード。離れた行は折りたたむ */
  function codeBlock(item, st) {
    const box = el('div', 'qcode');
    const lines = item.code.split('\n');
    let k = 0;
    const folded = new Map((item.folds || []).map(([a, b]) => [a, b]));
    for (let i = 0; i < lines.length; i++) {
      const lineEl = el('div', 'cl');
      lines[i].split(BLANK).forEach((part, n) => {
        if (n > 0) {
          const span = el('span', 'blank');
          span.dataset.k = String(k);
          span.textContent = `［${k + 1}］`;
          st.blankEls[k++] = span;
          lineEl.appendChild(span);
        }
        lineEl.appendChild(document.createTextNode(part));
      });
      if (!lineEl.textContent) lineEl.innerHTML = '&nbsp;';
      if (folded.has(i)) {
        const end = folded.get(i);
        const btn = el('div', 'foldbtn');
        btn.textContent = `… ${end - i + 1}行省略(クリックで表示)`;
        const hidden = el('div', 'folded');
        hidden.hidden = true;
        btn.addEventListener('click', () => { hidden.hidden = false; btn.remove(); });
        box.appendChild(btn);
        box.appendChild(hidden);
        hidden.appendChild(lineEl);
        for (i++; i <= end; i++) {
          const more = el('div', 'cl');
          more.textContent = lines[i] || ' ';
          hidden.appendChild(more);
        }
        i = end;
      } else box.appendChild(lineEl);
    }
    return box;
  }

  function blankControls(item, st, k) {
    const b = item.blanks[k];
    const box = el('div', 'qblank');
    const head = el('div', 'qhead', `<span class="qno">［${k + 1}］</span><span class="concept">${esc(b.concept)}</span>`);
    const hintBtn = el('button', 'link');
    hintBtn.textContent = '手がかり';
    head.appendChild(hintBtn);
    box.appendChild(head);
    const opts = el('div', 'qopts');
    b.options.forEach((code, i) => {
      const o = el('button', 'opt');
      o.textContent = code;
      o.addEventListener('click', () => {
        if (st.locked) return;
        st.chosen[k] = i;
        opts.querySelectorAll('.opt').forEach((x, n) => x.classList.toggle('sel', n === i));
        st.blankEls[k].textContent = code;
        st.blankEls[k].classList.add('filled');
        st.refresh();
      });
      opts.appendChild(o);
    });
    box.appendChild(opts);
    const hints = el('div', 'qhints');
    box.appendChild(hints);
    // 手がかりは段階的に: 概念 → 考え方 → 手がかりの場所 → 誤りの選択肢を1つ消す
    const stages = b.hints.map((h) => () => hints.appendChild(textBlock('hint', h)));
    if (b.clue) {
      stages.push(() => {
        const d = el('div', 'wtext hint');
        d.appendChild(fileLink(b.clue.path, b.clue.line));
        d.appendChild(document.createTextNode(b.clue.note ? ` — ${b.clue.note}` : ''));
        hints.appendChild(d);
      });
    }
    if (b.eliminate) {
      stages.push(() => {
        const o = opts.children[b.eliminate.index];
        o.classList.add('out');
        o.disabled = true;
        if (st.chosen[k] === b.eliminate.index) {
          st.chosen[k] = -1;
          o.classList.remove('sel');
          st.blankEls[k].textContent = `［${k + 1}］`;
          st.blankEls[k].classList.remove('filled');
          st.refresh();
        }
        hints.appendChild(textBlock('hint', `「${b.options[b.eliminate.index]}」は違います。${b.eliminate.note || ''}`));
      });
    }
    let used = 0;
    if (!stages.length) hintBtn.remove();
    hintBtn.addEventListener('click', () => {
      if (st.locked || used >= stages.length) return;
      stages[used++]();
      if (used >= stages.length) hintBtn.remove();
    });
    st.blankBoxes[k] = box;
    return box;
  }

  function addStep(w, v) {
    const reading = w.kind === 'reading';
    const st = { view: v, chosen: [], next: new Set(), blankEls: [], blankBoxes: [], locked: false, refresh: () => {} };
    const card = el('section', 'wstep');
    card.appendChild(el('div', 'whead', `<span class="wnum">${reading ? '読みどころ' : 'ステップ'} ${v.number}/${v.total}</span><span class="tag">${esc(v.kind)}</span>`));
    st.labelEl = textBlock('wlabel', v.label);
    card.appendChild(st.labelEl);
    if (v.why) {
      const sec = section('変更の理由');
      st.whyEl = textBlock('', v.why);
      sec.appendChild(st.whyEl);
      card.appendChild(sec);
    }
    if (v.contract) {
      const sec = section('変わる約束');
      st.contractEl = textBlock('', v.contract);
      sec.appendChild(st.contractEl);
      card.appendChild(sec);
    }
    if (v.item) {
      const it = v.item;
      const sec = section(reading ? 'どこを、どう読むか' : '変更するコード');
      if (it.task) sec.appendChild(textBlock('', it.task));
      const where = el('div', 'wfiles');
      where.appendChild(fileLink(it.path, it.startLine));
      sec.appendChild(where);
      if (it.newNames && it.newNames.length) {
        sec.appendChild(textBlock('names', '新しく作る名前: ' + it.newNames.map((n) => n.name + (n.role ? `(${n.role})` : '')).join('、')));
      }
      (it.refs || []).forEach((r) => {
        const d = el('div', 'wtext ref');
        d.appendChild(document.createTextNode('参考: '));
        d.appendChild(fileLink(r.path, r.line));
        d.appendChild(document.createTextNode(r.note ? ` — ${r.note}` : ''));
        sec.appendChild(d);
      });
      st.chosen = it.blanks.map(() => -1);
      sec.appendChild(codeBlock(it, st));
      it.blanks.forEach((_, k) => sec.appendChild(blankControls(it, st, k)));
      card.appendChild(sec);
    } else if (v.files && v.files.length && !(v.diffs || []).length) {
      const where = el('div', 'wfiles');
      v.files.forEach((f) => where.appendChild(fileLink(f.path, f.line)));
      card.appendChild(where);
    }
    (v.diffs || []).forEach((d) => card.appendChild(diffBlock(d)));
    if (v.question) {
      const q = v.question;
      const sec = section('影響はどこに及ぶか');
      sec.appendChild(textBlock('', q.prompt));
      const opts = el('div', 'qopts col');
      q.options.forEach((label, i) => {
        const o = el('button', 'opt');
        o.textContent = label;
        o.addEventListener('click', () => {
          if (st.locked) return;
          if (!q.multi) st.next.clear();
          if (st.next.has(i) && q.multi) st.next.delete(i);
          else st.next.add(i);
          opts.querySelectorAll('.opt').forEach((x, n) => x.classList.toggle('sel', st.next.has(n)));
          st.refresh();
        });
        opts.appendChild(o);
      });
      st.nextEl = opts;
      sec.appendChild(opts);
      if (q.hint) {
        const hintBtn = el('button', 'link');
        hintBtn.textContent = '探し方の手がかり';
        hintBtn.addEventListener('click', () => { sec.appendChild(textBlock('hint', q.hint)); hintBtn.remove(); });
        sec.appendChild(hintBtn);
      }
      card.appendChild(sec);
    }
    const actions = el('div', 'wactions');
    if (v.item || v.question) {
      const check = el('button', 'primary');
      check.textContent = '考えを確かめる';
      st.refresh = () => { check.disabled = st.locked || st.chosen.some((c) => c < 0) || (!!v.question && st.next.size === 0); };
      check.addEventListener('click', () => {
        st.locked = true;
        st.refresh();
        card.querySelectorAll('.opt, .link').forEach((b) => (b.disabled = true));
        vscode.postMessage({ type: 'walk_answer', index: v.index, blanks: st.chosen, next: [...st.next] });
      });
      st.refresh();
      actions.appendChild(check);
    }
    st.actions = actions;
    card.appendChild(actions);
    st.reveal = el('div', 'wreveal');
    card.appendChild(st.reveal);
    st.card = card;
    w.steps.set(v.index, st);
    w.el.appendChild(card);
    card.scrollIntoView({ block: 'start' });
  }

  function addReveal(w, r) {
    const st = w.steps.get(r.index);
    if (!st) return;
    st.locked = true;
    st.actions.innerHTML = '';
    st.card.querySelectorAll('.opt, .link').forEach((b) => (b.disabled = true));
    // 答える前は伏せていた文章を、全文に戻す
    if (st.labelEl) st.labelEl.textContent = r.label;
    if (st.whyEl && r.why) st.whyEl.textContent = r.why;
    if (st.contractEl && r.contract) st.contractEl.textContent = r.contract;
    const item = st.view.item;
    (r.blanks || []).forEach((b, k) => {
      const span = st.blankEls[k];
      if (span) {
        span.textContent = b.answer;
        span.classList.add('filled', b.correct ? 'ok' : 'attn');
      }
      const box = st.blankBoxes[k];
      if (!box) return;
      const res = el('div', 'qres ' + (b.correct ? 'ok' : 'attn'));
      if (b.correct) res.appendChild(textBlock('', '✓ 合っています' + (b.why ? ` — ${b.why}` : '')));
      else {
        res.appendChild(el('div', 'wtext', `<code>${esc(b.answer)}</code> になる理由: ${esc(b.why || '')}`));
        if (b.chosen >= 0 && b.note) res.appendChild(el('div', 'wtext', `選んだ <code>${esc(item.blanks[k].options[b.chosen])}</code> は: ${esc(b.note)}`));
      }
      box.appendChild(res);
    });
    if (r.question && st.nextEl) {
      [...st.nextEl.children].forEach((o, i) => {
        if (r.question.correctIndexes.includes(i)) o.classList.add('ok');
        else if (r.question.chosen.includes(i)) o.classList.add('attn');
      });
      const names = r.question.correctIndexes.map((i) => st.view.question.options[i]).join('、');
      st.nextEl.after(textBlock('qres ' + (r.question.correct ? 'ok' : 'attn'), r.question.correct ? '✓ 合っています' : `確認が必要になるのは: ${names}`));
    }
    if (r.explanation) {
      const sec = section(w.kind === 'reading' ? 'このコードの役割' : 'この変更の役割');
      sec.appendChild(textBlock('', r.explanation));
      st.reveal.appendChild(sec);
    }
    if (item && (r.diffs || []).length) {
      const sec = section('変更の全体');
      r.diffs.forEach((d) => sec.appendChild(diffBlock(d)));
      st.reveal.appendChild(sec);
    }
    if ((r.checks || []).length) {
      const sec = section('判断と根拠(影響の追い方)');
      r.checks.forEach((c) => {
        const box = el('div', 'check');
        box.appendChild(el('div', 'chead', `<strong>${esc(c.pattern)}</strong> — <code>${esc(c.subject)}</code>`));
        box.appendChild(textBlock('small', `きっかけ: ${c.trigger}\n探し方: ${c.howToFind}\n判断基準: ${c.criterion}`));
        c.results.forEach((p) => {
          const row = el('div', 'site ' + p.verdict);
          row.appendChild(el('span', 'badge', esc(VERDICT[p.verdict] + (p.step ? ` → ステップ${p.step}` : ''))));
          row.appendChild(fileLink(p.path, p.line, p.label));
          if (p.reason) row.appendChild(textBlock('small', p.reason));
          else if (p.verdict === 'unseen') row.appendChild(textBlock('small', '作業の中で読まれていません。必要なら自分で確かめてください。'));
          box.appendChild(row);
        });
        if (c.more > 0) box.appendChild(textBlock('small', `ほかに${c.more}か所あります。`));
        sec.appendChild(box);
      });
      st.reveal.appendChild(sec);
    }
    const next = el('button', 'primary wnext');
    next.textContent = r.last ? (w.kind === 'reading' ? '回答を見る' : '変更の全体像へ') : w.kind === 'reading' ? '次の読みどころへ' : '次のステップへ';
    next.addEventListener('click', () => { next.disabled = true; vscode.postMessage({ type: 'walk_next' }); });
    st.actions.appendChild(next);
  }

  function addFinal(w, f) {
    const card = el('section', 'wstep wfinal');
    card.appendChild(textBlock('wlabel', '変更の全体像'));
    if (f.notice) card.appendChild(textBlock('attn', f.notice));
    if (f.overall) card.appendChild(textBlock('', f.overall));
    const files = section('反映するファイル');
    f.files.forEach((x) => {
      const row = el('div', 'frow');
      row.appendChild(fileLink(x.path));
      row.appendChild(el('span', 'stat', `${x.created ? '新規 ' : x.deleted ? '削除 ' : ''}<span class="plus">+${x.added}</span> <span class="minus">−${x.removed}</span>`));
      files.appendChild(row);
      if (x.diff) {
        const d = el('details', 'fdiff');
        d.appendChild(el('summary', '', '差分'));
        d.appendChild(diffBlock({ path: x.path, diff: x.diff }));
        files.appendChild(d);
      }
    });
    card.appendChild(files);
    const ran = section('実行して確かめたこと');
    if (f.commands.length) f.commands.forEach((c) => ran.appendChild(el('div', 'cmdrow ' + (c.ok ? 'ok' : 'attn'), `${c.ok ? '✓' : '!'} <code>${esc(c.command)}</code>`)));
    else ran.appendChild(textBlock('small', 'テストやビルドなどのコマンドは実行されていません。'));
    card.appendChild(ran);
    if (f.unseen.length || f.unseenMore) {
      const sec = section('確かめられていない場所');
      sec.appendChild(textBlock('small', '変更の影響が及びうるのに、作業の中で読まれなかった場所です。反映の前後に確かめてください。'));
      f.unseen.forEach((u) => {
        const row = el('div', 'site unseen');
        row.appendChild(fileLink(u.path, u.line, u.label));
        row.appendChild(textBlock('small', `${u.pattern}(${u.subject})`));
        sec.appendChild(row);
      });
      if (f.unseenMore) sec.appendChild(textBlock('small', `ほかに${f.unseenMore}か所あります。`));
      card.appendChild(sec);
    }
    if (f.unheld.length) {
      const sec = section('取り置けなかったファイル');
      sec.appendChild(textBlock('small', 'バイナリなど、内容を控えられなかったファイルです。すでに書き換わっています: ' + f.unheld.join('、')));
      card.appendChild(sec);
    }
    const actions = el('div', 'wactions');
    const apply = el('button', 'primary');
    apply.textContent = '反映する';
    apply.addEventListener('click', () => vscode.postMessage({ type: 'walk_apply' }));
    const discard = el('button', 'secondary');
    discard.textContent = '破棄する';
    discard.addEventListener('click', () => vscode.postMessage({ type: 'walk_discard' }));
    actions.appendChild(apply);
    actions.appendChild(discard);
    card.appendChild(actions);
    w.finalActions = actions;
    w.errorEl = el('div', 'note error');
    card.appendChild(w.errorEl);
    w.el.appendChild(card);
    card.scrollIntoView({ block: 'start' });
  }

  function onWalk(m) {
    if (m.type === 'walk_start') {
      const v = m.view;
      const box = el('div', 'walk');
      const w = { el: box, kind: v.kind, steps: new Map() };
      walks.set(m.walk, w);
      const head = el('section', 'wstep wstart');
      head.appendChild(textBlock('wlabel', v.kind === 'reading' ? '何を理解するか' : '要件の整理'));
      head.appendChild(textBlock('', v.goal));
      if (v.notice) head.appendChild(textBlock('attn', v.notice));
      if (v.criteria.length) {
        const sec = section('受け入れ条件');
        v.criteria.forEach((c, i) => sec.appendChild(textBlock('', `${i + 1}. ${c}`)));
        head.appendChild(sec);
      }
      if (v.map.length) {
        const sec = section(v.kind === 'reading' ? '読みどころ' : '実装するステップ');
        v.map.forEach((s) => sec.appendChild(el('div', 'maprow', `<span class="mno">${s.number}.</span><span>${esc(s.label)}</span><span class="tag">${esc(s.kind)}</span>`)));
        head.appendChild(sec);
      }
      if (v.kind !== 'reading') {
        head.appendChild(textBlock('small', '変更はまだファイルに書き込まれていません。手順をたどり終えると、まとめて反映できます。'));
      }
      box.appendChild(head);
      append(box);
      head.scrollIntoView({ block: 'start' });
      return;
    }
    const w = walks.get(m.walk);
    if (!w) return;
    if (m.type === 'walk_step') addStep(w, m.view);
    else if (m.type === 'walk_reveal') addReveal(w, m.view);
    else if (m.type === 'walk_final') addFinal(w, m.view);
    else if (m.type === 'walk_error') {
      if (w.errorEl) w.errorEl.textContent = m.message;
      else addNote('error', m.message);
    } else if (m.type === 'walk_done') {
      w.el.classList.add('closed');
      w.el.querySelectorAll('button').forEach((b) => (b.disabled = true));
      if (w.finalActions) w.finalActions.remove();
      if (w.errorEl) w.errorEl.textContent = '';
      if (m.message) {
        const note = el('div', 'note wdone');
        note.textContent = m.message;
        w.el.appendChild(note);
      }
    }
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
    const counts = progress ? `(読み取り ${progress.read}・検索 ${progress.search}・編集 ${progress.edit}・実行 ${progress.command})` : '';
    $('statusText').textContent = waiting ? '許可を待っています…' : statusNote || `作業中…${counts}`;
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
    $('understand').checked = s.understand;
    $('level').value = s.level;
    if (!s.busy) { progress = null; statusNote = ''; }
    inputEl.disabled = !s.hasKey || !s.hasWorkspace;
    inputEl.placeholder = !s.hasWorkspace
      ? 'フォルダを開くと利用できます'
      : s.holding
        ? '続きの指示を入力すると、取り置いた変更を戻して作業を続けます'
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
  $('understand').addEventListener('change', (e) => vscode.postMessage({ type: 'setUnderstand', on: e.target.checked }));
  $('level').addEventListener('change', (e) => vscode.postMessage({ type: 'setLevel', level: e.target.value }));
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
        walks.clear();
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
      case 'walk': onWalk(m.message); break;
      case 'record': addRecord(m.items); break;
      case 'progress': progress = m.counts; updateStatus(); break;
      case 'status': statusNote = m.text; updateStatus(); break;
      case 'permission_request': showPermission(m.toolCallId, m.key); break;
      case 'permission_cancel': toolEls.get(m.toolCallId)?.querySelector('.perm')?.remove(); updateStatus(); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
