// Webview 側のUI。依存ライブラリなしの素のDOM操作。
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const messagesEl = $('messages');
  const inputEl = $('input');
  const sendEl = $('send');
  const statusEl = $('status');
  const MAX_SHOWN_OUTPUT = 8000;

  let state = { hasKey: true, busy: false, permissionMode: 'acceptEdits', hasWorkspace: true, level: 'intermediate', testMode: false };
  let activity = ''; // いま行っている作業 (ホストから届く1行の文)
  let settingsOpen = false;
  let streaming = null; // { el, text, scheduled }

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
      } else if (/^\s*#{1,6}\s/.test(line)) {
        // 箇条書きの中などで字下げされた見出しも、見出しとして扱う
        const m = line.match(/^\s*(#{1,6})\s+(.*)$/);
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
        // 最初の行は必ず取り込む (どの種類にも当てはまらなかった行で止まったままになると、描画が終わらず画面が固まる)
        const para = [lines[i++]];
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

  // ---------- 許可の確認 (入力欄の上) ----------
  // コマンドや編集の呼び出しは会話に出さない。許可が要るときだけ、ここで尋ねる
  const permEl = $('permission');
  let permId = '';

  function showPermission(m) {
    permId = m.toolCallId;
    permEl.innerHTML = '';
    const text = el('div', 'ptext');
    text.textContent = m.title;
    permEl.appendChild(text);
    if (m.detail) {
      const pre = el('pre', 'pdetail');
      pre.textContent = m.detail;
      permEl.appendChild(pre);
    }
    const row = el('div', 'prow');
    const respond = (behavior) => {
      hidePermission(m.toolCallId);
      vscode.postMessage({ type: 'permission_response', toolCallId: m.toolCallId, decision: { behavior } });
    };
    const btn = (label, behavior, cls) => {
      const b = el('button', cls);
      b.textContent = label;
      b.addEventListener('click', () => respond(behavior));
      row.appendChild(b);
    };
    btn('許可', 'allow', 'primary');
    btn('今後も許可', 'always', 'secondary');
    btn('拒否', 'deny', 'secondary');
    permEl.appendChild(row);
    permEl.hidden = false;
    updateStatus();
  }
  function hidePermission(id) {
    if (id && id !== permId) return;
    permId = '';
    permEl.hidden = true;
    permEl.innerHTML = '';
    updateStatus();
  }

  function renderItem(item) {
    if (item.kind === 'user') addUser(item.text);
    else if (item.kind === 'assistant') addAssistant(item.text);
    else if (item.kind === 'walk') onWalk(item.message);
    else if (item.kind === 'ask') addAsk(item);
    else addNote(item.kind, item.text);
  }

  // ---------- 実装の前に決めること ----------
  const askEls = new Map();

  /** 受け入れ条件が一つに決まらないとき、どう作るかを利用者が選ぶ */
  function addAsk(item) {
    const card = el('section', 'wstep ask');
    card.appendChild(textBlock('wlabel', '実装の前に決めること'));
    const done = Array.isArray(item.answers);
    const picked = item.questions.map(() => -1);
    const inputs = [];
    const send = el('button', 'primary');
    const refresh = () => { send.disabled = picked.some((p, i) => p < 0 && !inputs[i].value.trim()); };
    item.questions.forEach((q, i) => {
      const sec = section('');
      sec.appendChild(textBlock('qtitle', q.question));
      if (q.why) sec.appendChild(textBlock('small', q.why));
      const opts = el('div', 'qopts col');
      q.options.forEach((o, n) => {
        const b = el('button', 'opt choice');
        b.appendChild(el('span', 'olabel', esc(o.label) + (n === 0 ? '<span class="tag">おすすめ</span>' : '')));
        if (o.detail) b.appendChild(el('span', 'odetail', esc(o.detail)));
        if (done) {
          b.disabled = true;
          if (item.answers[i] === o.label) b.classList.add('sel');
        }
        b.addEventListener('click', () => {
          picked[i] = picked[i] === n ? -1 : n;
          opts.querySelectorAll('.opt').forEach((x, k) => x.classList.toggle('sel', k === picked[i]));
          refresh();
        });
        opts.appendChild(b);
      });
      sec.appendChild(opts);
      const input = el('input', 'other');
      input.type = 'text';
      input.placeholder = 'ほかの案・補足があれば入力';
      input.addEventListener('input', refresh);
      if (done) {
        input.disabled = true;
        if (!q.options.some((o) => o.label === item.answers[i])) input.value = item.answers[i] || '';
      }
      inputs.push(input);
      sec.appendChild(input);
      card.appendChild(sec);
    });
    if (!done) {
      send.textContent = 'この方針で進める';
      send.addEventListener('click', () => {
        // 選んだ案に、補足があれば添える
        const answers = item.questions.map((q, i) => {
          const choice = picked[i] >= 0 ? q.options[picked[i]].label : '';
          const note = inputs[i].value.trim();
          return choice && note ? `${choice}(補足: ${note})` : choice || note;
        });
        card.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
        send.remove();
        vscode.postMessage({ type: 'ask_response', id: item.id, answers });
      });
      refresh();
      const actions = el('div', 'wactions');
      actions.appendChild(send);
      card.appendChild(actions);
    }
    askEls.set(item.id, card);
    append(card);
    card.scrollIntoView({ block: 'start' });
  }

  // ---------- たどる手順 ----------
  const BLANK = '___BLANK___';
  const VERDICT = { changed: '変更が必要', checked: '変更は不要' };
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
    hintBtn.textContent = 'ヒントを見る';
    head.appendChild(hintBtn);
    box.appendChild(head);
    const opts = el('div', 'qopts');
    st.optEls[k] = opts;
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
    const st = { view: v, chosen: [], next: new Set(), blankEls: [], blankBoxes: [], optEls: [], locked: false, refresh: () => {} };
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
      const sec = section('ほかの場所に影響する変更点');
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
        // この変更で初めて登場する変数・関数など。どこにも定義が無い名前なので、先に示しておく
        const names = el('div', 'names');
        names.appendChild(textBlock('small', 'この変更で新しく追加する変数・関数'));
        it.newNames.forEach((n) => names.appendChild(el('div', 'nrow', `<code>${esc(n.name)}</code>${n.role ? `<span>${esc(n.role)}</span>` : ''}`)));
        sec.appendChild(names);
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
      const sec = section('この変更の影響');
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
        hintBtn.textContent = '探し方のヒントを見る';
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
      // 選択肢の中で、このコードになるものと、選んだものを色で示す
      [...(st.optEls[k] ? st.optEls[k].children : [])].forEach((o, i) => {
        if (i === b.correctIndex) o.classList.add('ok');
        else if (i === b.chosen) o.classList.add('attn');
      });
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
      // どれが該当するかは選択肢の色で示す (違っていたときに、同じ内容を文章で繰り返さない)
      if (r.question.correct) st.nextEl.after(textBlock('qres ok', '✓ 合っています'));
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
      // 影響の確認: この変更で変わったものを使っている場所と、それぞれ変更が要るかどうか
      const sec = section('影響の確認');
      r.checks.forEach((c) => {
        const box = el('div', 'check');
        box.appendChild(el('div', 'chead', `<code>${esc(c.subject)}</code> を使っている場所 <span class="tag">${esc(c.pattern)}</span>`));
        box.appendChild(textBlock('small', `見るところ: ${c.criterion}`));
        c.results.forEach((p) => {
          const row = el('div', 'site ' + p.verdict);
          row.appendChild(el('span', 'badge', esc(VERDICT[p.verdict] + (p.step ? ` → ステップ${p.step}` : ''))));
          row.appendChild(fileLink(p.path, p.line, p.label));
          if (p.reason) row.appendChild(textBlock('small', p.reason));
          box.appendChild(row);
        });
        const rest = (c.others || []).length + (c.more || 0);
        if (rest > 0) {
          // 作業の中で読まれなかった場所は、判断が無いので、控えめに一覧だけを添える
          const d = el('details', 'others');
          d.appendChild(el('summary', '', `ほかに、同じ名前が出てくる場所が${rest}か所あります`));
          (c.others || []).forEach((p) => {
            const row = el('div', 'site');
            row.appendChild(fileLink(p.path, p.line, p.label));
            d.appendChild(row);
          });
          box.appendChild(d);
        }
        sec.appendChild(box);
      });
      st.reveal.appendChild(sec);
    }
    const next = el('button', 'primary wnext');
    next.textContent = r.last ? (w.kind === 'reading' ? '回答を見る' : '変更の全体像へ') : w.kind === 'reading' ? '次の読みどころへ' : '次のステップへ';
    next.addEventListener('click', () => { next.disabled = true; vscode.postMessage({ type: 'walk_next' }); });
    const after = el('div', 'wactions');
    after.appendChild(next);
    st.card.appendChild(after);
  }

  function addFinal(w, f) {
    const card = el('section', 'wstep wfinal');
    card.appendChild(textBlock('wlabel', '変更の全体像'));
    if (f.notice) card.appendChild(textBlock('attn', f.notice));
    if (f.overall) card.appendChild(textBlock('', f.overall));

    if (f.criteria.length) {
      const sec = section('受け入れ条件');
      f.criteria.forEach((c, i) => {
        const row = el('div', 'crow');
        row.appendChild(el('span', 'mno', `${i + 1}.`));
        row.appendChild(textBlock('', c.text));
        if (c.steps.length) row.appendChild(el('span', 'tag', esc('ステップ ' + c.steps.join('・'))));
        sec.appendChild(row);
      });
      card.appendChild(sec);
    }

    if (f.steps.length) {
      const sec = section('たどった手順');
      f.steps.forEach((s) => {
        const row = el('div', 'srow');
        row.appendChild(el('span', 'mno', `${s.number}.`));
        const body = el('div', 'sbody');
        body.appendChild(textBlock('stitle', s.label));
        const meta = el('div', 'smeta');
        s.files.forEach((p) => meta.appendChild(fileLink(p)));
        if (s.origin) meta.appendChild(el('span', 'tag', esc(s.origin)));
        body.appendChild(meta);
        row.appendChild(body);
        sec.appendChild(row);
      });
      card.appendChild(sec);
    }

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

    // 動作確認: 何をどこまで確かめてあるかを文章で示し、実行したコマンドは結果とともに添える
    const ran = section('動作確認');
    if (f.verification) ran.appendChild(textBlock('', f.verification));
    if (f.commands.length) {
      f.commands.forEach((c) => {
        const row = el('div', 'cmdrow');
        row.appendChild(el('span', 'badge ' + (c.ok ? 'ok' : 'ng'), c.ok ? '成功' : '失敗'));
        const body = el('div', 'sbody');
        if (c.description) body.appendChild(textBlock('', c.description));
        body.appendChild(el('code', '', esc(c.command)));
        row.appendChild(body);
        ran.appendChild(row);
      });
    } else if (!f.verification) {
      ran.appendChild(textBlock('small', 'テストやビルドは実行されていません。反映したあとに、テストを実行して動作を確かめてください。'));
    }
    card.appendChild(ran);

    if (f.unheld.length) {
      const sec = section('すでに書き換わっているファイル');
      sec.appendChild(textBlock('small', '画像などのファイルは、この画面から反映・破棄ができません: ' + f.unheld.join('、')));
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
    statusEl.hidden = !state.busy;
    $('statusText').textContent = permId ? '許可を待っています…' : activity || '作業中…';
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
    $('level').value = s.level;
    $('testMode').checked = s.testMode;
    $('capture').hidden = !s.testMode;
    if (!s.busy) activity = '';
    inputEl.disabled = !s.hasKey || !s.hasWorkspace;
    inputEl.placeholder = !s.hasWorkspace
      ? 'フォルダを開くと利用できます'
      : '質問や実装の指示を入力';
    updateStatus();
  }

  // ---------- 画面の保存 (テストモード) ----------
  /**
   * 会話の全体 (スクロールで隠れている部分も含む) と入力欄を、1枚の画像にしてホストへ渡す。
   * 画面の複製を SVG の foreignObject に入れて描く。スタイルシートは Webview から読めないので、ホストから本文を受け取る。
   */
  async function capture(css) {
    try {
      const width = document.documentElement.clientWidth;
      const height = document.body.clientHeight - messagesEl.clientHeight + messagesEl.scrollHeight;
      // 複製はページに挿さず、文字列として組み立てる (配色の変数は、VS Code が html 要素に付けているものを引き継ぐ)
      const extra = `
        .capture-root { display: flex; flex-direction: column; box-sizing: border-box; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5;
          background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1f1f1f)); }
        .capture-root #messages { overflow: visible; flex: none; }
        .capture-root .qcode, .capture-root pre, .capture-root .diff { overflow: hidden; max-height: none; }
        .capture-root * { animation: none !important; }`;
      const style = document.createElement('style');
      style.textContent = css + extra;
      const serializer = new XMLSerializer();
      const parts = [serializer.serializeToString(style)];
      const live = [...document.body.querySelectorAll('input, textarea, select')];
      for (const child of document.body.children) {
        if (child.tagName === 'SCRIPT') continue;
        const clone = child.cloneNode(true);
        // 入力中の内容は属性に無いので、複製に写す
        const originals = [...child.querySelectorAll('input, textarea, select')];
        clone.querySelectorAll('input, textarea, select').forEach((node, i) => {
          const from = originals[i];
          if (!from || !live.includes(from)) return;
          if (node.tagName === 'TEXTAREA') node.textContent = from.value;
          else if (node.tagName === 'SELECT') [...node.options].forEach((o, k) => (k === from.selectedIndex ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
          else if (from.type === 'checkbox') from.checked ? node.setAttribute('checked', '') : node.removeAttribute('checked');
          else if (from.type !== 'password') node.setAttribute('value', from.value);
        });
        parts.push(serializer.serializeToString(clone));
      }
      const now = getComputedStyle(document.body);
      const bg = [now.backgroundColor, getComputedStyle(document.documentElement).backgroundColor].find((c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') || '#1f1f1f';
      const vars = esc(`${document.documentElement.getAttribute('style') || ''};color:${now.color};font-family:${now.fontFamily};font-size:${now.fontSize};background:${bg}`);
      const xhtml = `<div xmlns="http://www.w3.org/1999/xhtml" class="capture-root" style="${vars};width:${width}px;height:${height}px;">${parts.join('')}</div>`;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('画像を描けませんでした'));
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      });
      // 長い会話でも描けるよう、キャンバスの上限に合わせて倍率を下げる
      const scale = Math.max(0.25, Math.min(2, 16000 / height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      vscode.postMessage({ type: 'capture_result', dataUrl: canvas.toDataURL('image/png') });
    } catch (e) {
      vscode.postMessage({ type: 'capture_result', error: String((e && e.message) || e) });
    }
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
  $('testMode').addEventListener('change', (e) => vscode.postMessage({ type: 'setTestMode', on: e.target.checked }));
  $('capture').addEventListener('click', () => vscode.postMessage({ type: 'capture_request' }));
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
        hidePermission();
        walks.clear();
        askEls.clear();
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
      case 'ask': addAsk(m); break;
      case 'ask_cancel': askEls.get(m.id)?.querySelectorAll('button, input').forEach((x) => (x.disabled = true)); break;
      case 'activity': activity = m.text; updateStatus(); break;
      case 'capture': capture(m.css); break;
      case 'permission_request': showPermission(m); break;
      case 'permission_cancel': hidePermission(m.toolCallId); break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
