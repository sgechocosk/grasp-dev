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
  // 読む量を抑えるため、答える前に見せるのは「見出し・目的の1行・コード・問い」だけにする。
  // 答え合わせで開いて見せるのは、予想が外れたこと (または「わからない」) を正す情報だけ。ほかの解説は折りたたんで添える。
  const BLANK = '___BLANK___';
  const UNKNOWN = -2; // 「わからない」を選んだことを表す、選択肢の番号
  const VERDICT = { changed: '変更が必要', checked: '変更は不要' };
  const WHOLE_FILE_LINES = 8; // 新しいファイル・消すファイルの差分で、最初に見せる行数
  const walks = new Map(); // walk の番号 → { el, kind, steps: Map(index → stepState) }

  function fileLink(path, line, text) {
    const a = el('span', 'flink');
    a.textContent = text || (line ? `${path}:${line}` : path);
    a.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path, line }));
    return a;
  }
  /** これから作るファイルは、まだ開けないので、リンクにせず名前だけを示す */
  function fileName(path) {
    const a = el('span', 'fname');
    a.textContent = path;
    return a;
  }
  /**
   * 問い・ヒント・解説は、どこに出ても同じ見た目にする: 左の線の色と、先頭の札で区別する。
   * - 問い (q): 利用者が答えるもの  - ヒント (hint): 答える前に、求めたときだけ出る手がかり  - 解説 (res): 答えたあとに出る説明
   */
  const KIND_LABEL = { q: '問い', hint: 'ヒント', res: '解説' };
  function kindTag(kind) {
    return el('span', 'ktag ' + kind, KIND_LABEL[kind]);
  }
  function hintBlock(node) {
    const d = el('div', 'kbox hint');
    d.appendChild(kindTag('hint'));
    if (typeof node === 'string') d.appendChild(textBlock('', node));
    else d.appendChild(node);
    return d;
  }
  /** 答え合わせの箱。合っていれば ok、違う・わからないなら attn */
  function resultBlock(ok) {
    const d = el('div', 'kbox res ' + (ok ? 'ok' : 'attn'));
    d.appendChild(kindTag('res'));
    if (ok) d.appendChild(textBlock('verdict', '合っています'));
    return d;
  }
  const calm = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function glide(node, block) {
    node.scrollIntoView({ block: block || 'start', behavior: calm ? 'auto' : 'smooth' });
  }
  /** 空欄と、その選択肢のつながりを示す: 相手の位置まで画面を動かし、短く光らせる */
  function pulse(node, block) {
    glide(node, block || 'nearest');
    node.classList.remove('pulse');
    void node.offsetWidth;
    node.classList.add('pulse');
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
  function codeLine(text) {
    const d = el('div', 'linecode');
    d.textContent = text;
    return d;
  }
  /** 折りたたんで添える部分 (open なら開いて見せる) */
  function fold(summary, open) {
    const d = el('details', 'more');
    d.open = !!open;
    d.appendChild(el('summary', '', esc(summary)));
    return d;
  }
  function diffBlock(d) {
    const box = el('div', 'wdiff');
    const head = el('div', 'dpath');
    head.appendChild(d.created ? fileName(d.path) : fileLink(d.path, d.line));
    if (d.created) head.appendChild(el('span', 'tag', '新規'));
    if (d.deleted) head.appendChild(el('span', 'tag', '削除'));
    box.appendChild(head);
    const row = (l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('…') ? 'skip' : '';
      return `<div class="${cls}">${esc(l) || '&nbsp;'}</div>`;
    };
    const lines = String(d.diff || '').split('\n');
    // 新しいファイル・消すファイルは、全部の行が並ぶ。最初の数行だけを見せ、残りは求めたときに開く
    const whole = (d.created || d.deleted) && lines.length > WHOLE_FILE_LINES + 3;
    const body = el('div', 'diff', (whole ? lines.slice(0, WHOLE_FILE_LINES) : lines).map(row).join(''));
    box.appendChild(body);
    if (whole) {
      const more = el('button', 'link');
      more.textContent = `残りの${lines.length - WHOLE_FILE_LINES}行を表示`;
      more.dataset.keep = '1';
      more.addEventListener('click', () => { body.innerHTML = lines.map(row).join(''); more.remove(); });
      box.appendChild(more);
    }
    return box;
  }
  /** 次のステップへは、画面をなめらかに動かす。続けて流しているステップでは、最初の1つにだけ合わせる (利用者が操作するまで動かさない) */
  function reveal(w, node) {
    if (!w.hold) glide(node);
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

  /**
   * 選択肢のボタンの並び。最後に「わからない」を置く (当て推量をさせない。選ぶと、答え合わせで解説を開く)。
   * render(button, i) で中身を描き、選ぶと onPick(i) が呼ばれる (i は選択肢の番号、または UNKNOWN)。
   */
  function optionRow(st, count, render, onPick, cls) {
    const opts = el('div', 'qopts ' + (cls || ''));
    const pick = (i) => {
      if (st.locked) return;
      opts.querySelectorAll('.opt').forEach((x) => x.classList.toggle('sel', Number(x.dataset.i) === i));
      onPick(i);
      st.refresh();
    };
    for (let i = 0; i < count; i++) {
      const o = el('button', 'opt');
      o.dataset.i = String(i);
      render(o, i);
      o.addEventListener('click', () => pick(i));
      opts.appendChild(o);
    }
    const unknown = el('button', 'opt unknown');
    unknown.dataset.i = String(UNKNOWN);
    unknown.textContent = 'わからない';
    unknown.addEventListener('click', () => pick(UNKNOWN));
    opts.appendChild(unknown);
    return opts;
  }

  function blankControls(item, st, k) {
    const b = item.blanks[k];
    const box = el('div', 'kbox q qblank');
    // 値で問うときは問いの文を、コードで問うときは何についての空欄かを見出しにする
    const head = el('div', 'qhead');
    head.appendChild(kindTag('q'));
    head.appendChild(el('span', 'qtext', `<span class="qno">［${k + 1}］</span>${esc(b.ask || `${b.concept}: ここに入るコードはどれですか?`)}`));
    box.appendChild(head);
    const hintBtn = el('button', 'link');
    hintBtn.textContent = 'ヒントを見る';
    // コードの空欄を押すと、その選択肢へ移る
    st.blankEls[k].classList.add('jump');
    st.blankEls[k].title = '選択肢へ';
    st.blankEls[k].addEventListener('click', () => pulse(box, 'center'));
    const blankText = (i) => (i >= 0 ? b.options[i] : `［${k + 1}］`);
    const opts = optionRow(st, b.options.length, (o, i) => { o.textContent = b.labels ? b.labels[i] : b.options[i]; }, (i) => {
      st.chosen[k] = i;
      st.blankEls[k].textContent = blankText(i);
      st.blankEls[k].classList.toggle('filled', i >= 0);
      // 選んだものが、コードのどこに入ったかを示す
      if (i >= 0) pulse(st.blankEls[k]);
    });
    st.optEls[k] = opts;
    box.appendChild(opts);
    box.appendChild(hintBtn);
    const hints = el('div', 'qhints');
    box.appendChild(hints);
    // 手がかりは段階的に: 概念 → 考え方 → 手がかりの場所 → 誤りの選択肢を1つ消す
    const stages = b.hints.map((h) => () => hints.appendChild(hintBlock(h)));
    if (b.clue) {
      stages.push(() => {
        const d = el('div', 'wtext');
        d.appendChild(fileLink(b.clue.path, b.clue.line));
        d.appendChild(document.createTextNode(b.clue.note ? ` — ${b.clue.note}` : ''));
        hints.appendChild(hintBlock(d));
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
          st.blankEls[k].textContent = blankText(-1);
          st.blankEls[k].classList.remove('filled');
          st.refresh();
        }
        const shown = b.labels ? b.labels[b.eliminate.index] : b.options[b.eliminate.index];
        hints.appendChild(hintBlock(`「${shown}」は違います。${b.eliminate.note || ''}`));
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

  /** 変更の影響の問い。形は経験レベルで変わる (行から選ぶ / 場所から選ぶ / 変えなかった場所をそのままにしてよいか判断する) */
  function impactControls(q, st) {
    const sec = el('div', 'kbox q');
    const qhead = el('div', 'qhead');
    qhead.appendChild(kindTag('q'));
    qhead.appendChild(el('span', 'qtext', esc(q.prompt)));
    sec.appendChild(qhead);
    if (q.form === 'review') {
      st.review = q.sites.map(() => -1);
      st.reviewEls = [];
      // なぜこれらの場所を確かめるのか。どの場所も同じ理由なら、1回だけ示す
      const shared = q.sites.every((x) => x.why === q.sites[0].why);
      if (shared && q.sites[0].why) sec.appendChild(textBlock('small', q.sites[0].why));
      q.sites.forEach((s, n) => {
        const box = el('div', 'rsite');
        const head = el('div', 'chead');
        head.appendChild(fileLink(s.path, s.line, s.label));
        box.appendChild(head);
        if (!shared && s.why) box.appendChild(textBlock('small', s.why));
        box.appendChild(codeLine(s.code));
        if (s.reason) box.appendChild(textBlock('small', `変更しない理由: ${s.reason}`));
        const picks = el('div', 'qopts');
        q.picks.forEach((label, i) => {
          const o = el('button', 'opt plain');
          o.textContent = label;
          o.addEventListener('click', () => {
            if (st.locked) return;
            st.review[n] = i;
            picks.querySelectorAll('.opt').forEach((x, m) => x.classList.toggle('sel', m === i));
            st.refresh();
          });
          picks.appendChild(o);
        });
        st.reviewEls[n] = picks;
        box.appendChild(picks);
        sec.appendChild(box);
      });
      return sec;
    }
    const render = (o, i) => {
      if (q.form === 'lines') {
        // 知らないファイルの名前からではなく、実際の行から選ぶ
        o.classList.add('choice');
        o.appendChild(codeLine(q.options[i].code));
        o.appendChild(el('span', 'odetail', esc(`${q.options[i].path}:${q.options[i].line}`)));
      } else o.textContent = q.options[i];
    };
    const opts = optionRow(st, q.options.length, render, (i) => {
      if (i === UNKNOWN || !q.multi) st.next.clear();
      st.nextUnknown = i === UNKNOWN;
      if (i !== UNKNOWN) {
        if (q.multi && st.next.has(i)) st.next.delete(i);
        else st.next.add(i);
      }
      // 複数選べる問いでは、選んだものをすべて示す
      opts.querySelectorAll('.opt').forEach((x) => x.classList.toggle('sel', st.nextUnknown ? Number(x.dataset.i) === UNKNOWN : st.next.has(Number(x.dataset.i))));
    }, 'col');
    st.nextEl = opts;
    sec.appendChild(opts);
    if (q.hint) {
      const hintBtn = el('button', 'link');
      hintBtn.textContent = '探し方のヒントを見る';
      hintBtn.addEventListener('click', () => { sec.appendChild(hintBlock(q.hint)); hintBtn.remove(); });
      sec.appendChild(hintBtn);
    }
    return sec;
  }

  function addStep(w, v) {
    const reading = w.kind === 'reading';
    const st = { view: v, chosen: [], next: new Set(), nextUnknown: false, review: [], blankEls: [], blankBoxes: [], optEls: [], locked: false, refresh: () => {} };
    const card = el('section', 'wstep');
    const head = el('div', 'whead', `<span class="wnum">${reading ? '読みどころ' : 'ステップ'} ${v.number}/${v.total}</span><span class="tag">${esc(v.kind)}</span>`);
    // どの条件・どのステップのための変更かは、文章で繰り返さず、札で示す
    if (v.origin) head.appendChild(el('span', 'tag origin', esc(v.origin)));
    card.appendChild(head);
    st.labelEl = textBlock('wlabel', v.label);
    card.appendChild(st.labelEl);
    if (v.purpose) card.appendChild(textBlock('', v.purpose));
    // 1画面に問いは1つ: 前の問いに答えてから、次の問いを出す
    const gates = [];
    if (v.item) {
      const it = v.item;
      const sec = section('');
      const where = el('div', 'wfiles');
      const created = (v.files || []).some((f) => f.path === it.path && f.created);
      where.appendChild(created ? fileName(it.path) : fileLink(it.path, it.startLine));
      if (created) where.appendChild(el('span', 'tag', '新規'));
      sec.appendChild(where);
      st.chosen = it.blanks.map(() => -1);
      sec.appendChild(codeBlock(it, st));
      it.blanks.forEach((_, k) => {
        const box = blankControls(it, st, k);
        gates.push({ el: box, done: () => st.chosen[k] !== -1 });
        sec.appendChild(box);
      });
      card.appendChild(sec);
    } else if (v.files && v.files.length && !(v.diffs || []).length) {
      const where = el('div', 'wfiles');
      v.files.forEach((f) => where.appendChild(f.created ? fileName(f.path) : fileLink(f.path, f.line)));
      card.appendChild(where);
    }
    (v.diffs || []).forEach((d) => card.appendChild(diffBlock(d)));
    if (v.question) {
      const sec = impactControls(v.question, st);
      st.nextBox = sec;
      const q = v.question;
      gates.push({ el: sec, done: () => (q.form === 'review' ? st.review.every((p) => p >= 0) : st.nextUnknown || st.next.size > 0) });
      card.appendChild(sec);
    }
    const actions = el('div', 'wactions');
    if (gates.length) {
      const check = el('button', 'primary');
      check.textContent = v.question && v.question.form === 'review' && !v.item ? '判断を確定する' : '考えを確かめる';
      st.refresh = () => {
        const open = gates.findIndex((g) => !g.done());
        if (v.oneAtATime) gates.forEach((g, n) => { g.el.hidden = open >= 0 && n > open; });
        check.disabled = st.locked || open >= 0;
      };
      check.addEventListener('click', () => {
        st.locked = true;
        w.hold = false;
        st.refresh();
        card.querySelectorAll('.opt, .link').forEach((b) => (b.disabled = true));
        vscode.postMessage({ type: 'walk_answer', index: v.index, blanks: st.chosen, next: [...st.next], nextUnknown: st.nextUnknown, review: st.review });
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
    reveal(w, card);
    if (v.flow) w.hold = true;
  }

  function addReveal(w, r) {
    const st = w.steps.get(r.index);
    if (!st) return;
    const reading = w.kind === 'reading';
    st.locked = true;
    st.actions.innerHTML = '';
    st.card.querySelectorAll('.opt').forEach((b) => (b.disabled = true));
    // 使わなかったヒントのリンクは片づける
    st.card.querySelectorAll('button.link').forEach((b) => { if (!b.dataset.keep) b.remove(); });
    // 答える前は伏せていた見出しを、全文に戻す
    if (st.labelEl) st.labelEl.textContent = r.label;
    const item = st.view.item;
    const shownAs = (k, i) => (item.blanks[k].labels ? item.blanks[k].labels[i] : item.blanks[k].options[i]);
    // 合っていた空欄の理由は、折りたたんだ解説の中に回す
    const quietWhys = [];
    (r.blanks || []).forEach((b, k) => {
      const span = st.blankEls[k];
      if (span) {
        span.textContent = b.answer;
        span.classList.add('filled', b.correct ? 'ok' : 'attn');
      }
      // 選択肢の中で、このコードになるものと、選んだものを色で示す
      [...(st.optEls[k] ? st.optEls[k].children : [])].forEach((o) => {
        const i = Number(o.dataset.i);
        if (i === b.correctIndex) o.classList.add('ok');
        else if (i === b.chosen) o.classList.add('attn');
      });
      const box = st.blankBoxes[k];
      if (!box) return;
      const why = el('div', 'wtext', `<code>${esc(b.answer)}</code> になる理由: ${esc(b.why || '')}`);
      const res = resultBlock(b.correct);
      if (b.correct) {
        if (b.why) quietWhys.push(why);
        if (b.calc) quietWhys.push(textBlock('small', `計算: ${b.calc}`));
      } else {
        // 予想が外れた・わからないときだけ、理由をその場で見せる
        if (b.why) res.appendChild(why);
        if (b.calc) res.appendChild(textBlock('', `計算: ${b.calc}`));
        if (b.chosen >= 0 && b.note) res.appendChild(el('div', 'wtext', `選んだ <code>${esc(shownAs(k, b.chosen))}</code> は: ${esc(b.note)}`));
      }
      box.appendChild(res);
    });
    const rq = r.question;
    if (rq && rq.form === 'review') {
      (st.reviewEls || []).forEach((row, n) => [...row.children].forEach((o, i) => o.classList.toggle('sel', i === rq.picks[n])));
      if (rq.concerns > 0) {
        const res = el('div', 'kbox res attn');
        res.appendChild(kindTag('res'));
        res.appendChild(textBlock('', `${rq.concerns}か所を、気になった場所として残しました。最後の「変更の全体像」でまとめて確かめられます。`));
        st.nextBox.appendChild(res);
      }
    } else if (rq && st.nextEl) {
      [...st.nextEl.children].forEach((o) => {
        const i = Number(o.dataset.i);
        if (rq.correctIndexes.includes(i)) o.classList.add('ok');
        else if (rq.chosen.includes(i) || (rq.unknown && i === UNKNOWN)) o.classList.add('attn');
      });
      // どれが該当するかは選択肢の色で示す (違っていたときに、同じ内容を文章で繰り返さない)
      const res = resultBlock(rq.correct);
      if (!rq.correct) res.appendChild(textBlock('', '該当するものは、緑の枠で示しています。'));
      st.nextBox.appendChild(res);
    }
    const d = r.detail;
    if (d && (d.explanation || (d.diffs || []).length || quietWhys.length)) {
      // 変更の理由・役割・差分は、予想を正す情報ではないので、いつでも開けるよう折りたたんで添える
      // 変更の理由は、目的の1行と空欄の理由で言っているので繰り返さない。差分は、変更前のコードを見られる唯一の場所
      const box = fold((d.diffs || []).length ? 'くわしく: この変更の役割と、変更前との違い' : 'くわしく: このコードの役割', false);
      quietWhys.forEach((n) => box.appendChild(n));
      if (d.explanation) {
        const sec = section(reading ? 'このコードの役割' : 'この変更の役割');
        sec.appendChild(textBlock('', d.explanation));
        box.appendChild(sec);
      }
      if ((d.diffs || []).length) {
        const sec = section('変更前との違い');
        d.diffs.forEach((x) => sec.appendChild(diffBlock(x)));
        box.appendChild(sec);
      }
      st.reveal.appendChild(box);
    }
    if ((r.checks || []).length) {
      // この変更で変わったものを使っている場所を、どう判断したか。必要なら見られるよう、いつも折りたたんで添える
      const box = fold('くわしく: ほかの場所への影響を、どう確かめたか', false);
      if (r.contract) box.appendChild(textBlock('', `変わる点: ${r.contract}`));
      r.checks.forEach((c) => {
        const sec = el('div', 'check');
        sec.appendChild(el('div', 'chead', `<code>${esc(c.subject)}</code> を使っている場所 <span class="tag">${esc(c.pattern)}</span>`));
        sec.appendChild(textBlock('small', `見るところ: ${c.criterion}`));
        c.results.forEach((p) => {
          const row = el('div', 'site ' + p.verdict);
          row.appendChild(el('span', 'badge', esc(VERDICT[p.verdict] + (p.step ? `(ステップ${p.step})` : ''))));
          row.appendChild(fileLink(p.path, p.line, p.label));
          // 判断の根拠になる行そのものを見せる。理由の文は、その場所に固有のものがあるときだけ
          if (p.code) row.appendChild(codeLine(p.code));
          if (p.reason) row.appendChild(textBlock('small', p.reason));
          sec.appendChild(row);
        });
        box.appendChild(sec);
      });
      st.reveal.appendChild(box);
    }
    // 続けて流しているステップには、進むボタンを置かない (次の問い・まとめ・最後まで自動で進む)
    if (r.flow) return;
    const end = r.recap ? 'まとめへ' : reading ? '回答を見る' : '変更の全体像へ';
    addNext(w, st.card, r.last ? end : reading ? '次の読みどころへ' : '次のステップへ');
  }

  function addNext(w, card, label) {
    const next = el('button', 'primary wnext');
    next.textContent = label;
    next.addEventListener('click', () => { next.disabled = true; w.hold = false; vscode.postMessage({ type: 'walk_next' }); });
    const after = el('div', 'wactions');
    after.appendChild(next);
    card.appendChild(after);
  }

  /**
   * まとめ: 仕組みを説明する文章の、部品の名前を選んで埋める。
   * 部品の役割とつながりを、自分で組み立て直せるかを確かめる。埋めた文章は、人に説明する材料として残る。
   */
  function addRecap(w, v) {
    const st = { chosen: v.blanks.map(() => -1), slots: v.blanks.map(() => []), optEls: [], boxes: [], locked: false, refresh: () => {} };
    const card = el('section', 'wstep wrecap');
    card.appendChild(textBlock('wlabel', v.kind === 'reading' ? '仕組みをまとめる' : '変更の流れをまとめる'));
    const text = el('div', 'wtext rtext');
    v.segments.forEach((seg) => {
      if (typeof seg === 'string') return text.appendChild(document.createTextNode(seg));
      const span = el('span', 'blank');
      span.textContent = `［${seg + 1}］`;
      st.slots[seg].push(span);
      text.appendChild(span);
    });
    card.appendChild(text);
    const gates = [];
    v.blanks.forEach((b, k) => {
      const box = el('div', 'kbox q qblank');
      const qhead = el('div', 'qhead');
      qhead.appendChild(kindTag('q'));
      qhead.appendChild(el('span', 'qtext', `<span class="qno">［${k + 1}］</span>ここに入る部品はどれですか?`));
      box.appendChild(qhead);
      const opts = optionRow(st, b.options.length, (o, i) => { o.textContent = b.options[i]; }, (i) => {
        st.chosen[k] = i;
        st.slots[k].forEach((s) => {
          s.textContent = i >= 0 ? b.options[i] : `［${k + 1}］`;
          s.classList.toggle('filled', i >= 0);
        });
        if (i >= 0 && st.slots[k][0]) pulse(st.slots[k][0]);
      });
      st.optEls[k] = opts;
      st.boxes[k] = box;
      box.appendChild(opts);
      gates.push({ el: box, done: () => st.chosen[k] !== -1 });
      card.appendChild(box);
    });
    const actions = el('div', 'wactions');
    const check = el('button', 'primary');
    check.textContent = '考えを確かめる';
    st.refresh = () => { check.disabled = st.locked || gates.some((g) => !g.done()); };
    check.addEventListener('click', () => {
      st.locked = true;
      w.hold = false;
      st.refresh();
      card.querySelectorAll('.opt').forEach((b) => (b.disabled = true));
      vscode.postMessage({ type: 'walk_recap_answer', picks: st.chosen });
    });
    st.refresh();
    actions.appendChild(check);
    card.appendChild(actions);
    st.actions = actions;
    st.card = card;
    w.recap = st;
    w.el.appendChild(card);
    reveal(w, card);
  }

  function addRecapReveal(w, r) {
    const st = w.recap;
    if (!st) return;
    st.locked = true;
    st.actions.innerHTML = '';
    st.card.querySelectorAll('.opt').forEach((b) => (b.disabled = true));
    r.blanks.forEach((b, k) => {
      st.slots[k].forEach((s) => {
        s.textContent = b.answer;
        s.classList.add('filled', b.correct ? 'ok' : 'attn');
      });
      [...st.optEls[k].children].forEach((o) => {
        const i = Number(o.dataset.i);
        if (i === b.correctIndex) o.classList.add('ok');
        else if (i === b.chosen) o.classList.add('attn');
      });
      const res = resultBlock(b.correct);
      if (!b.correct) {
        // 外れた・わからないときは、その部品がある場所を示す (開いて確かめられる)
        const d = el('div', 'wtext', `<code>${esc(b.answer)}</code> の場所: `);
        d.appendChild(fileLink(b.where.path, b.where.line));
        res.appendChild(d);
      }
      st.boxes[k].appendChild(res);
    });
    addNext(w, st.card, r.kind === 'reading' ? '回答を見る' : '変更の全体像へ');
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

    if ((f.concerns || []).length) {
      // 「妥当」以外を選んだ場所。反映の前に確かめられるよう、依頼の文を入力欄に用意する (送るのは利用者)
      const sec = section('気になった場所');
      f.concerns.forEach((c) => {
        const row = el('div', 'site');
        row.appendChild(el('span', 'badge', esc(c.pick)));
        row.appendChild(fileLink(c.path, c.line, c.label));
        sec.appendChild(row);
      });
      const ask = el('button', 'secondary');
      ask.textContent = '確認の依頼を入力欄に入れる';
      ask.addEventListener('click', () => {
        inputEl.value = ['次の場所について、変更が要らないかを確かめてください。', ...f.concerns.map((c) => `- ${c.label}(${c.path}:${c.line}): ${c.pick}`)].join('\n');
        inputEl.dispatchEvent(new Event('input'));
        inputEl.focus();
      });
      const row = el('div', 'wactions');
      row.appendChild(ask);
      sec.appendChild(row);
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
    reveal(w, card);
  }

  function onWalk(m) {
    if (m.type === 'walk_start') {
      const v = m.view;
      const box = el('div', 'walk');
      const w = { el: box, kind: v.kind, steps: new Map(), hold: false };
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
      // これからたどるステップの一覧。何を実装するのかの全体と、問いのあるステップが、ここで分かる
      if ((v.map || []).length) {
        const sec = section(v.kind === 'reading' ? '読みどころ' : '実装するステップ');
        v.map.forEach((s) => {
          const row = el('div', 'maprow', `<span class="mno">${s.number}.</span><span class="mlabel">${esc(s.label)}</span>`);
          if (s.question && v.kind !== 'reading') row.appendChild(kindTag('q'));
          sec.appendChild(row);
        });
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
    else if (m.type === 'walk_recap') addRecap(w, m.view);
    else if (m.type === 'walk_recap_reveal') addRecapReveal(w, m.view);
    else if (m.type === 'walk_final') addFinal(w, m.view);
    else if (m.type === 'walk_error') {
      if (w.errorEl) w.errorEl.textContent = m.message;
      else addNote('error', m.message);
      // 同じ場所が書き換えられていたときは、上書きして反映する選択肢を足す (元に戻して「反映する」を押し直すこともできる)
      if ((m.conflicts || []).length && w.finalActions && !w.finalActions.querySelector('.overwrite')) {
        const force = el('button', 'secondary overwrite');
        force.textContent = '上書きして反映する';
        force.addEventListener('click', () => vscode.postMessage({ type: 'walk_apply', overwrite: true }));
        w.finalActions.insertBefore(force, w.finalActions.children[1] || null);
      }
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
