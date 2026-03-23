/*!
 * NexusAI Chat Widget v1.0.0
 * Embed: <script src="widget.js" data-agent="AGENT_ID" data-color="#00e5c0" defer></script>
 */
(function () {
  'use strict';

  // ── Read config from script tag ───────────────────────────────────────────
  var script =
    document.currentScript ||
    Array.from(document.querySelectorAll('script[data-agent]')).pop();

  if (!script) return;

  var C = {
    agentId:     script.dataset.agent       || '',
    color:       script.dataset.color       || '#00e5c0',
    welcome:     script.dataset.welcome     || 'Hi there! How can I help you today? 👋',
    title:       script.dataset.title       || 'Support',
    position:    script.dataset.position    || 'bottom-right',
    apiBase:     script.dataset.api         || 'http://nexusai-alb-732208425.ap-southeast-1.elb.amazonaws.com/api/v1',
    token:       script.dataset.token       || '',
    branding:    script.dataset.branding    !== 'false',
    suggestions: script.dataset.suggestions ? script.dataset.suggestions.split('|') : [],
  };

  if (!C.agentId) {
    console.warn('[NexusAI] data-agent attribute is required.');
    return;
  }

  // Prevent double-init
  if (window.__nexusai_loaded) return;
  window.__nexusai_loaded = true;

  // ── Session state ─────────────────────────────────────────────────────────
  var CONV_KEY = 'nai_conv_' + C.agentId;
  var MSGS_KEY = 'nai_msgs_' + C.agentId;
  var convId   = null;
  try { convId = sessionStorage.getItem(CONV_KEY); } catch(e) {}

  var isOpen    = false;
  var isLoading = false;
  var messages  = [];

  function saveSession() {
    try {
      if (convId) sessionStorage.setItem(CONV_KEY, convId);
      sessionStorage.setItem(MSGS_KEY, JSON.stringify(messages));
    } catch(e) {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(CONV_KEY);
      sessionStorage.removeItem(MSGS_KEY);
    } catch(e) {}
    convId = null;
    messages = [];
  }

  // ── Colour helpers ────────────────────────────────────────────────────────
  function hexToRgb(hex) {
    var r = parseInt(hex.slice(1,3),16);
    var g = parseInt(hex.slice(3,5),16);
    var b = parseInt(hex.slice(5,7),16);
    return { r:r, g:g, b:b };
  }
  function colorAlpha(hex, a) {
    var c = hexToRgb(hex);
    return 'rgba('+c.r+','+c.g+','+c.b+','+a+')';
  }
  function isDark(hex) {
    var c = hexToRgb(hex);
    return (c.r*299 + c.g*587 + c.b*114) / 1000 < 128;
  }
  var textOnColor = isDark(C.color) ? '#ffffff' : '#000000';

  // ── Simple markdown renderer ──────────────────────────────────────────────
  function renderMarkdown(raw) {
    var text = raw || '';

    // Product cards (```product {...} ```)
    text = text.replace(/```product\n?([\s\S]*?)```/g, function(_, json) {
      try {
        var p = JSON.parse(json.trim());
        var img  = p.image       ? '<div class="nai-pc-img"><img src="'+escHtml(p.image)+'" alt="'+escHtml(p.name)+'"></div>' : '';
        var badge= p.badge       ? '<span class="nai-pc-badge">'+escHtml(p.badge)+'</span>' : '';
        var desc = p.description ? '<p class="nai-pc-desc">'+escHtml(p.description)+'</p>' : '';
        var price= p.price       ? '<p class="nai-pc-price">'+escHtml(p.price)+'</p>' : '';
        var link = p.url         ? '<a href="'+escHtml(p.url)+'" target="_blank" rel="noopener" class="nai-cta">View product ↗</a>' : '';
        return '<div class="nai-product-card">'+img+'<div class="nai-pc-body">'+badge+'<strong class="nai-pc-name">'+escHtml(p.name)+'</strong>'+desc+price+link+'</div></div>';
      } catch(e) { return '<pre>'+escHtml(json)+'</pre>'; }
    });

    // Fenced code blocks
    text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre class="nai-pre"><code>$1</code></pre>');

    // Escape remaining HTML (outside blocks already replaced)
    // We do a targeted approach — escape only in non-HTML segments
    // Bold / italic / inline code / links (applied after block-level)
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code class="nai-code">$1</code>');

    // CTA links → pill buttons
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener" class="nai-cta">$1 ↗</a>');

    // Unordered lists — group consecutive lines into one <ul>
    text = text.replace(/((?:^[ \t]*[-*] .+(?:\n|$))+)/gm, function(block) {
      var items = block.trim().split('\n').map(function(line) {
        return '<li>' + line.replace(/^[ \t]*[-*] /, '') + '</li>';
      });
      return '<ul class="nai-ul">' + items.join('') + '</ul>';
    });

    // Ordered lists — group consecutive lines into one <ol>
    text = text.replace(/((?:^[ \t]*\d+\. .+(?:\n|$))+)/gm, function(block) {
      var items = block.trim().split('\n').map(function(line) {
        return '<li>' + line.replace(/^[ \t]*\d+\. /, '') + '</li>';
      });
      return '<ol class="nai-ol">' + items.join('') + '</ol>';
    });

    // Headings
    text = text.replace(/^### (.+)$/gm, '<p class="nai-h3">$1</p>');
    text = text.replace(/^## (.+)$/gm,  '<p class="nai-h2">$1</p>');
    text = text.replace(/^# (.+)$/gm,   '<p class="nai-h1">$1</p>');

    // Tables — must run before paragraph conversion
    text = text.replace(/((?:(?:\|[^\n]*\|[ \t]*\n)+))/g, function(block) {
      var rows = block.trim().split('\n').filter(function(r) { return r.trim(); });
      if (rows.length < 2) return block;
      // Check second row is separator (|---|---|)
      if (!/^\|[-| :]+\|$/.test(rows[1].trim())) return block;
      var html = '<table class="nai-table">';
      rows.forEach(function(row, i) {
        if (i === 1) return; // skip separator row
        var cells = row.trim().replace(/^\||\|$/g, '').split('|');
        var tag = i === 0 ? 'th' : 'td';
        html += '<tr>' + cells.map(function(c) {
          return '<' + tag + '>' + c.trim() + '</' + tag + '>';
        }).join('') + '</tr>';
      });
      html += '</table>';
      return html;
    });

    // Blockquotes
    text = text.replace(/^> (.+)$/gm, '<blockquote class="nai-bq">$1</blockquote>');

    // HR
    text = text.replace(/^---$/gm, '<hr class="nai-hr">');

    // Paragraphs: double newline → break
    text = text.replace(/\n\n+/g, '</p><p class="nai-p">');
    text = '<p class="nai-p">' + text + '</p>';

    // Single newline inside paragraph
    text = text.replace(/\n/g, '<br>');

    return text;
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  // ── CSS ───────────────────────────────────────────────────────────────────
  var posRight = C.position !== 'bottom-left';
  var css = [
    // Reset inside widget only
    '#nai-root,#nai-root *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;}',

    // FAB button
    '#nai-fab{position:fixed;'+(posRight?'right:24px':'left:24px')+';bottom:24px;width:56px;height:56px;border-radius:50%;background:'+C.color+';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px rgba(0,0,0,0.25);transition:transform .2s,box-shadow .2s;z-index:2147483646;}',
    '#nai-fab:hover{transform:scale(1.08);box-shadow:0 6px 28px rgba(0,0,0,0.3);}',
    '#nai-fab svg{transition:transform .25s;}',

    // Unread badge
    '#nai-badge{position:absolute;top:-3px;right:-3px;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;font-size:10px;font-weight:700;color:#fff;display:flex;align-items:center;justify-content:center;display:none;}',

    // Chat window
    '#nai-window{position:fixed;'+(posRight?'right:24px':'left:24px')+';bottom:96px;width:380px;max-width:calc(100vw - 32px);height:580px;max-height:calc(100vh - 120px);background:#0f1117;border:1px solid rgba(255,255,255,0.08);border-radius:20px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 16px 48px rgba(0,0,0,0.4);z-index:2147483645;transition:opacity .2s,transform .2s;opacity:0;transform:translateY(12px) scale(0.97);pointer-events:none;}',
    '#nai-window.nai-open{opacity:1;transform:translateY(0) scale(1);pointer-events:all;}',

    // Header
    '#nai-header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(135deg,'+C.color+','+colorAlpha(C.color,0.7)+');flex-shrink:0;}',
    '#nai-avatar{width:34px;height:34px;border-radius:50%;background:rgba(0,0,0,0.2);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:'+textOnColor+';flex-shrink:0;}',
    '#nai-hinfo{flex:1;min-width:0;}',
    '#nai-htitle{font-size:14px;font-weight:700;color:'+textOnColor+';line-height:1.2;}',
    '#nai-hstatus{font-size:11px;color:'+textOnColor+';opacity:0.75;margin-top:1px;}',
    '#nai-restart,#nai-close{background:rgba(0,0,0,0.15);border:none;cursor:pointer;color:'+textOnColor+';width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s;}',
    '#nai-restart:hover,#nai-close:hover{background:rgba(0,0,0,0.3);}',

    // Suggestion pills
    '#nai-suggestions{display:flex;flex-wrap:wrap;gap:6px;padding:0 14px 10px;}',
    '.nai-pill{background:transparent;border:1px solid '+colorAlpha(C.color,0.4)+';color:'+C.color+';border-radius:99px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s;white-space:nowrap;font-family:inherit;}',
    '.nai-pill:hover{background:'+colorAlpha(C.color,0.12)+';border-color:'+colorAlpha(C.color,0.7)+';}',

    // Messages area
    '#nai-msgs{flex:1;overflow-y:auto;padding:16px 14px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth;}',
    '#nai-msgs::-webkit-scrollbar{width:4px;}',
    '#nai-msgs::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:4px;}',

    // Bubbles
    '.nai-row{display:flex;align-items:flex-end;gap:8px;}',
    '.nai-row.nai-user{justify-content:flex-end;}',
    '.nai-msg-av{width:28px;height:28px;border-radius:50%;background:'+colorAlpha(C.color,0.15)+';border:1px solid '+colorAlpha(C.color,0.3)+';flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:'+C.color+';letter-spacing:.02em;margin-bottom:18px;}',
    '.nai-col{display:flex;flex-direction:column;gap:3px;max-width:78%;}',
    '.nai-col-user{align-items:flex-end;}',
    '.nai-bubble{padding:10px!important;border-radius:16px;font-size:13.5px;line-height:1.55;word-break:break-word;}',
    '.nai-bubble.nai-bot{background:#1c2030;border:1px solid rgba(255,255,255,0.08);color:#dde3ef;border-bottom-left-radius:4px;}',
    '.nai-bubble.nai-user{background:'+C.color+';color:'+textOnColor+';border-bottom-right-radius:4px;font-weight:500;}',
    '.nai-ts{font-size:10px;color:#3d4455;padding:0 2px;}',
    '.nai-ts-user{text-align:right;}',

    // Markdown inside bubbles
    '.nai-p{margin-bottom:4px!important;line-height:1.55;}.nai-p:last-child{margin-bottom:0!important;}',
    '.nai-h1{font-size:1.1em;font-weight:700;margin-bottom:4px;}',
    '.nai-h2{font-size:1.05em;font-weight:700;margin-bottom:4px;}',
    '.nai-h3{font-weight:600;margin-bottom:4px;}',
    '.nai-ul{padding-left:18px!important;margin:4px 0 6px 8px!important;list-style:disc;}',
    '.nai-ol{padding-left:18px!important;margin:4px 0 6px 8px!important;list-style:decimal;}',
    '.nai-ul li,.nai-ol li{margin-bottom:1px!important;line-height:1.5;}',
    '.nai-code{background:rgba(0,229,192,0.12);color:#00e5c0;padding:1px 5px;border-radius:4px;font-family:monospace;font-size:0.85em;}',
    '.nai-pre{background:#0a0c12;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;overflow-x:auto;margin:6px 0;}',
    '.nai-pre code{font-family:monospace;font-size:0.82em;color:#a0aec0;}',
    '.nai-bq{border-left:2px solid '+C.color+';padding-left:10px;opacity:0.75;font-style:italic;margin:4px 0;}',
    '.nai-hr{border:none;border-top:1px solid rgba(255,255,255,0.1);margin:8px 0;}',

    // CTA links
    '.nai-cta{display:inline-flex;align-items:center;gap:3px;padding:3px 9px;background:'+colorAlpha(C.color,0.15)+';border:1px solid '+colorAlpha(C.color,0.35)+';color:'+C.color+';border-radius:8px;font-size:12px;font-weight:600;text-decoration:none;transition:background .15s,border-color .15s;cursor:pointer;}',
    '.nai-cta:hover{background:'+colorAlpha(C.color,0.25)+';border-color:'+colorAlpha(C.color,0.6)+';}',
    '.nai-bubble.nai-user .nai-cta{background:rgba(0,0,0,0.15);border-color:rgba(0,0,0,0.2);color:'+textOnColor+';}',

    // Product card
    '.nai-product-card{background:#12151f;border:1px solid '+colorAlpha(C.color,0.2)+';border-radius:12px;overflow:hidden;max-width:240px;margin:6px 0;transition:border-color .15s;}',
    '.nai-product-card:hover{border-color:'+colorAlpha(C.color,0.5)+';}',
    '.nai-pc-img{height:120px;overflow:hidden;background:#1a1d27;}',
    '.nai-pc-img img{width:100%;height:100%;object-fit:cover;}',
    '.nai-pc-body{padding:10px 12px;}',
    '.nai-pc-badge{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:'+C.color+';background:'+colorAlpha(C.color,0.12)+';border-radius:99px;padding:2px 7px;margin-bottom:4px;}',
    '.nai-pc-name{display:block;font-size:13px;font-weight:700;color:#e2e8f0;line-height:1.3;margin-bottom:3px;}',
    '.nai-pc-desc{font-size:11px;color:#6b7280;margin-bottom:5px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.nai-pc-price{font-size:14px;font-weight:700;color:'+C.color+';margin-bottom:8px;}',
    '.nai-product-card .nai-cta{font-size:11.5px;width:100%;;justify-content:center;}',

    // Tables
    '.nai-table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0;}',
    '.nai-table th,.nai-table td{border:1px solid rgba(255,255,255,0.1);padding:5px 9px;text-align:left;line-height:1.4;}',
    '.nai-table th{background:rgba(255,255,255,0.05);font-weight:600;color:#e2e8f0;}',
    '.nai-table td{color:#a0aec0;}',
    '.nai-table tr:hover td{background:rgba(255,255,255,0.03);}',

    // Typing indicator
    '#nai-typing{display:none;padding:0 16px 4px;}',
    '#nai-typing.nai-show{display:block;}',
    '.nai-dots{display:inline-flex;align-items:center;gap:4px;background:#1a1d27;border:1px solid rgba(255,255,255,0.07);padding:10px 14px;border-radius:16px;border-bottom-left-radius:4px;}',
    '.nai-dot{width:6px;height:6px;border-radius:50%;background:#4b5563;animation:nai-bounce 1.2s infinite;}',
    '.nai-dot:nth-child(2){animation-delay:.2s;}',
    '.nai-dot:nth-child(3){animation-delay:.4s;}',
    '@keyframes nai-bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',

    // Input area
    '#nai-footer{padding:12px;background:#0f1117;border-top:1px solid rgba(255,255,255,0.06);flex-shrink:0;}',
    '#nai-form{display:flex;gap:8px;align-items:flex-end;}',
    '#nai-input{flex:1;background:#1a1d27;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:9px 12px;font-size:13.5px;color:#e2e8f0;outline:none;resize:none;max-height:100px;line-height:1.5;transition:border-color .15s;font-family:inherit;}',
    '#nai-input::placeholder{color:#4b5563;}',
    '#nai-input:focus{border-color:'+colorAlpha(C.color,0.5)+';}',
    '#nai-send{width:38px;height:38px;border-radius:10px;background:'+C.color+';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,transform .1s;}',
    '#nai-send:hover:not(:disabled){background:'+colorAlpha(C.color,0.85)+';transform:scale(1.05);}',
    '#nai-send:disabled{opacity:0.45;cursor:default;}',

    // Branding
    '#nai-branding{text-align:center;padding:5px 0 2px;font-size:10px;color:#374151;}',
    '#nai-branding a{color:#4b5563;text-decoration:none;}',
    '#nai-branding a:hover{color:'+C.color+';}',
  ].join('\n');

  // ── DOM construction ──────────────────────────────────────────────────────
  function buildWidget() {
    // Style tag
    var styleEl = document.createElement('style');
    styleEl.textContent = css;
    document.head.appendChild(styleEl);

    // Root container (no shadow DOM — simpler and more compatible)
    var root = document.createElement('div');
    root.id = 'nai-root';
    document.body.appendChild(root);

    // FAB
    var fab = document.createElement('button');
    fab.id = 'nai-fab';
    fab.setAttribute('aria-label', 'Open chat');
    fab.innerHTML = chatIcon() + '<span id="nai-badge">1</span>';
    root.appendChild(fab);

    // Chat window
    var win = document.createElement('div');
    win.id = 'nai-window';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', C.title);
    win.innerHTML = [
      '<div id="nai-header">',
        '<div id="nai-avatar">AI</div>',
        '<div id="nai-hinfo">',
          '<div id="nai-htitle">'+escHtml(C.title)+'</div>',
          '<div id="nai-hstatus">● Online</div>',
        '</div>',
        '<button id="nai-restart" aria-label="Start over" title="Start over">'+restartIcon()+'</button>',
        '<button id="nai-close" aria-label="Close chat">'+closeIcon()+'</button>',
      '</div>',
      '<div id="nai-msgs" role="log" aria-live="polite"></div>',
      '<div id="nai-suggestions"></div>',
      '<div id="nai-typing"><div class="nai-dots"><div class="nai-dot"></div><div class="nai-dot"></div><div class="nai-dot"></div></div></div>',
      '<div id="nai-footer">',
        '<form id="nai-form">',
          '<textarea id="nai-input" rows="1" placeholder="Type a message…" aria-label="Message"></textarea>',
          '<button id="nai-send" type="submit" aria-label="Send">'+sendIcon()+'</button>',
        '</form>',
        C.branding ? '<div id="nai-branding">Powered by <a href="https://nexusai.io" target="_blank" rel="noopener">NexusAI</a></div>' : '',
      '</div>',
    ].join('');
    root.appendChild(win);

    return {
      fab:    fab,
      win:    win,
      msgs:   win.querySelector('#nai-msgs'),
      typing: win.querySelector('#nai-typing'),
      form:   win.querySelector('#nai-form'),
      input:   win.querySelector('#nai-input'),
      send:    win.querySelector('#nai-send'),
      close:   win.querySelector('#nai-close'),
      restart: win.querySelector('#nai-restart'),
    };
  }

  // ── Icons (inline SVG) ────────────────────────────────────────────────────
  function chatIcon() {
    return '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="'+textOnColor+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  }
  function closeIcon() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="'+textOnColor+'" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  }
  function restartIcon() {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="'+textOnColor+'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.67"/></svg>';
  }
  function sendIcon() {
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="'+textOnColor+'" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
  }

  // ── Time helper ───────────────────────────────────────────────────────────
  function formatTime(d) {
    var h = d.getHours(), m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ampm;
  }

  // ── Row builder (shared by appendMessage + streaming) ─────────────────────
  function buildRow(role, id) {
    var row = document.createElement('div');
    row.className = 'nai-row' + (role === 'user' ? ' nai-user' : '');
    if (id) row.dataset.id = id;

    if (role !== 'user') {
      var av = document.createElement('div');
      av.className = 'nai-msg-av';
      av.textContent = 'AI';
      row.appendChild(av);
    }

    var col = document.createElement('div');
    col.className = 'nai-col' + (role === 'user' ? ' nai-col-user' : '');

    var bubble = document.createElement('div');
    bubble.className = 'nai-bubble ' + (role === 'user' ? 'nai-user' : 'nai-bot');

    var ts = document.createElement('div');
    ts.className = 'nai-ts' + (role === 'user' ? ' nai-ts-user' : '');
    ts.textContent = formatTime(new Date());

    col.appendChild(bubble);
    col.appendChild(ts);
    row.appendChild(col);
    return { row: row, bubble: bubble };
  }

  // ── Message helpers ───────────────────────────────────────────────────────
  function appendMessage(role, content, id, skipSave) {
    var r = buildRow(role, id);

    if (role === 'user') {
      r.bubble.textContent = content;
    } else {
      r.bubble.innerHTML = renderMarkdown(content);
    }

    el.msgs.appendChild(r.row);
    scrollBottom();

    if (!skipSave) {
      messages.push({ role: role, content: content });
      saveSession();
      // Hide suggestion pills after first user message
      if (role === 'user') {
        var sg = document.getElementById('nai-suggestions');
        if (sg) sg.style.display = 'none';
      }
    }

    return r.bubble;
  }

  // ── Suggestion pills ─────────────────────────────────────────────────────
  function renderSuggestions() {
    if (!C.suggestions.length) return;
    var el2 = document.getElementById('nai-suggestions');
    if (!el2) return;
    C.suggestions.forEach(function(text) {
      var btn = document.createElement('button');
      btn.className = 'nai-pill';
      btn.textContent = text;
      btn.addEventListener('click', function() {
        el2.style.display = 'none';
        el.input.value = '';
        sendMessage(text);
      });
      el2.appendChild(btn);
    });
  }

  // ── Start over ────────────────────────────────────────────────────────────
  function startOver() {
    clearSession();
    el.msgs.innerHTML = '';
    var sg = document.getElementById('nai-suggestions');
    if (sg) { sg.innerHTML = ''; sg.style.display = 'flex'; }
    appendMessage('bot', C.welcome, null, true);
    renderSuggestions();
  }

  function updateMessage(id, content) {
    var row = el.msgs.querySelector('[data-id="'+id+'"]');
    if (!row) return;
    var bubble = row.querySelector('.nai-bubble');
    if (bubble) bubble.innerHTML = renderMarkdown(content);
    scrollBottom();
  }

  function scrollBottom() {
    el.msgs.scrollTop = el.msgs.scrollHeight;
  }

  function setTyping(show) {
    el.typing.className = show ? 'nai-show' : '';
    if (show) scrollBottom();
  }

  function setDisabled(disabled) {
    el.send.disabled  = disabled;
    el.input.disabled = disabled;
    isLoading = disabled;
  }

  // ── Open / close ──────────────────────────────────────────────────────────
  function openWidget() {
    isOpen = true;
    el.win.classList.add('nai-open');
    el.fab.setAttribute('aria-expanded', 'true');
    setTimeout(function() { el.input.focus(); }, 250);
  }

  function closeWidget() {
    isOpen = false;
    el.win.classList.remove('nai-open');
    el.fab.setAttribute('aria-expanded', 'false');
  }

  // ── Send message ──────────────────────────────────────────────────────────
  function sendMessage(text) {
    if (!text || isLoading) return;

    appendMessage('user', text);
    setDisabled(true);
    setTyping(true);

    // Create empty bot bubble for streaming
    var msgId = 'bot-' + Date.now();
    var built = buildRow('bot', msgId);
    var botRow = built.row;
    var botBubble = built.bubble;

    var accumulated = '';
    var firstChunk  = true;

    var body = JSON.stringify({
      message: text,
      conversationId: convId || undefined,
      stream: true,
    });

    var headers = { 'Content-Type': 'application/json' };
    if (C.token) headers['Authorization'] = 'Bearer ' + C.token;

    fetch(C.apiBase + '/agents/' + C.agentId + '/chat', {
      method:  'POST',
      headers: headers,
      body:    body,
    })
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);

      var contentType = res.headers.get('content-type') || '';

      // ── Streaming SSE response ──────────────────────────────────────────
      if (contentType.includes('text/event-stream') || contentType.includes('text/plain')) {
        var reader  = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer  = '';

        function read() {
          return reader.read().then(function(r) {
            if (r.done) {
              setTyping(false);
              setDisabled(false);
              if (!accumulated) {
                botBubble.innerHTML = renderMarkdown("I'm sorry, I couldn't process that. Please try again.");
              }
              return;
            }

            buffer += decoder.decode(r.value, { stream: true });
            var lines = buffer.split('\n');
            buffer = lines.pop() || '';

            var currentEvent = '';
            lines.forEach(function(line) {
              var trimmed = line.trim();
              if (!trimmed) { currentEvent = ''; return; }

              if (trimmed.startsWith('event:')) {
                currentEvent = trimmed.slice(6).trim();
                return;
              }

              if (!trimmed.startsWith('data:')) return;
              var raw = trimmed.slice(5).trim();
              if (raw === '[DONE]') return;

              // API sends event: done to signal end of stream
              if (currentEvent === 'done') {
                setTyping(false);
                setDisabled(false);
                return;
              }

              try {
                var parsed = JSON.parse(raw);
                var chunk =
                  parsed.token   ||
                  parsed.text    ||
                  parsed.delta   ||
                  parsed.content ||
                  (parsed.choices && parsed.choices[0] && (
                    (parsed.choices[0].delta && parsed.choices[0].delta.content) ||
                    parsed.choices[0].text
                  )) || '';

                if (chunk) {
                  accumulated += chunk;
                  if (firstChunk) {
                    firstChunk = false;
                    setTyping(false);
                    el.msgs.appendChild(botRow);
                    scrollBottom();
                  }
                  botBubble.innerHTML = renderMarkdown(accumulated);
                  scrollBottom();
                }

                if (parsed.conversationId || parsed.conversation_id) {
                  convId = parsed.conversationId || parsed.conversation_id;
                  try { sessionStorage.setItem(CONV_KEY, convId); } catch(e) {}
                }

                if (parsed.done === true) {
                  setTyping(false);
                  setDisabled(false);
                }
              } catch(e) {
                // Raw text chunk
                if (raw) {
                  accumulated += raw;
                  if (firstChunk) {
                    firstChunk = false;
                    setTyping(false);
                    el.msgs.appendChild(botRow);
                  }
                  botBubble.innerHTML = renderMarkdown(accumulated);
                  scrollBottom();
                }
              }
            });

            return read();
          });
        }

        return read().catch(function(err) {
          console.error('[NexusAI] Stream error:', err);
          fallbackError(botBubble);
          setTyping(false);
          setDisabled(false);
        });
      }

      // ── Non-streaming JSON response ─────────────────────────────────────
      return res.json().then(function(data) {
        setTyping(false);
        var reply = data.reply || data.data && data.data.reply || '';
        var newConvId = data.conversationId || data.conversation_id ||
                        (data.data && (data.data.conversationId || data.data.conversation_id));

        if (newConvId) {
          convId = newConvId;
          try { sessionStorage.setItem(CONV_KEY, convId); } catch(e) {}
        }

        botBubble.innerHTML = renderMarkdown(reply || "I'm sorry, I couldn't process that.");
        el.msgs.appendChild(botRow);
        scrollBottom();
        setDisabled(false);
      });
    })
    .catch(function(err) {
      console.error('[NexusAI] Error:', err);
      setTyping(false);
      fallbackError(botBubble);
      el.msgs.appendChild(botRow);
      scrollBottom();
      setDisabled(false);
    });
  }

  function fallbackError(bubble) {
    bubble.innerHTML = renderMarkdown("Sorry, I'm having trouble connecting. Please try again in a moment.");
  }

  // ── Wire up events ────────────────────────────────────────────────────────
  var el;

  function init() {
    el = buildWidget();

    // Restore previous session or show welcome
    var saved = [];
    try { saved = JSON.parse(sessionStorage.getItem(MSGS_KEY) || '[]'); } catch(e) {}

    if (saved.length) {
      saved.forEach(function(m) { appendMessage(m.role, m.content, null, true); });
    } else {
      appendMessage('bot', C.welcome, null, true);
      renderSuggestions();
    }

    // FAB toggle
    el.fab.addEventListener('click', function() {
      isOpen ? closeWidget() : openWidget();
    });

    // Close button
    el.close.addEventListener('click', closeWidget);

    // Restart button
    el.restart.addEventListener('click', startOver);

    // Form submit
    el.form.addEventListener('submit', function(e) {
      e.preventDefault();
      var text = el.input.value.trim();
      if (!text || isLoading) return;
      el.input.value = '';
      autoResize(el.input);
      sendMessage(text);
    });

    // Auto-resize textarea & Enter key
    el.input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        el.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }
    });
    el.input.addEventListener('input', function() { autoResize(el.input); });

    // Close on Escape
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && isOpen) closeWidget();
    });
  }

  function autoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 100) + 'px';
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose API for programmatic control
  window.NexusAI = {
    open:  openWidget,
    close: closeWidget,
    send:  sendMessage,
  };

}(window));
