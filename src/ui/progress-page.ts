/**
 * Returns the HTML page for the progress viewer.
 * Sidebar + main area layout: left sidebar lists all operations by creation time,
 * clicking an item shows its full log in the main area.
 * Active operations auto-focus; multiple concurrent ops shown via sidebar.
 */
export function getProgressPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Dev — Progress</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
    background: #0d1117;
    color: #c9d1d9;
    font-size: 13px;
    line-height: 1.5;
  }
  #header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 42px;
  }
  #header h1 { font-size: 14px; font-weight: 600; color: #58a6ff; }
  .header-right { display: flex; align-items: center; gap: 8px; }
  #clear-btn {
    font-family: inherit; font-size: 11px; padding: 2px 10px;
    border-radius: 4px; border: 1px solid #30363d;
    background: #21262d; color: #8b949e; cursor: pointer;
  }
  #clear-btn:hover { background: #30363d; color: #c9d1d9; }
  #conn-status {
    font-size: 12px; padding: 2px 8px; border-radius: 12px;
    background: #1f6feb33; color: #58a6ff;
  }
  #conn-status.connected { background: #23863533; color: #3fb950; }
  #conn-status.disconnected { background: #f8514933; color: #f85149; }

  /* Layout: sidebar + main */
  #container {
    display: flex;
    height: calc(100vh - 42px);
  }

  /* Sidebar */
  #sidebar {
    width: 220px;
    min-width: 220px;
    background: #0d1117;
    border-right: 1px solid #21262d;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  #sidebar-header {
    padding: 8px 12px;
    font-size: 11px;
    font-weight: 600;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #21262d;
    flex-shrink: 0;
  }
  #sidebar-list {
    flex: 1;
    overflow-y: auto;
  }
  .sidebar-item {
    padding: 6px 12px;
    cursor: pointer;
    border-bottom: 1px solid #161b22;
    display: flex;
    align-items: center;
    gap: 8px;
    transition: background 0.1s;
  }
  .sidebar-item:hover { background: #161b22; }
  .sidebar-item.active { background: #1f6feb22; border-left: 2px solid #58a6ff; }
  .sidebar-item .dot {
    width: 8px; height: 8px; border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-running { background: #e3b341; animation: pulse 1.5s ease-in-out infinite; }
  .dot-done { background: #3fb950; }
  .dot-failed { background: #f85149; }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .sidebar-info { flex: 1; overflow: hidden; }
  .sidebar-label {
    font-size: 12px; font-weight: 600; color: #c9d1d9;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sidebar-meta {
    font-size: 10px; color: #484f58;
    display: flex; gap: 6px; align-items: center;
  }
  .sidebar-time { }
  .sidebar-desc {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    max-width: 120px;
  }

  /* Main area */
  #main {
    flex: 1;
    overflow-y: auto;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  #main-header {
    padding: 8px 16px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    font-size: 13px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  #main-header .dot { width: 8px; height: 8px; border-radius: 50%; }
  #main-label { flex: 1; }
  #main-status {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
  }
  .status-running { background: #d2992233; color: #e3b341; }
  .status-done    { background: #23863533; color: #3fb950; }
  .status-failed  { background: #f8514933; color: #f85149; }

  #main-body {
    flex: 1;
    overflow-y: auto;
    padding: 4px 12px;
  }

  .entry {
    padding: 3px 0;
    border-bottom: 1px solid #21262d;
    display: flex;
    gap: 6px;
    align-items: flex-start;
  }
  .entry:last-child { border-bottom: none; }
  .ts { color: #484f58; flex-shrink: 0; min-width: 65px; font-size: 12px; }
  .tag {
    display: inline-block; padding: 0 5px; border-radius: 4px;
    font-size: 10px; font-weight: 600; flex-shrink: 0;
    min-width: 75px; text-align: center;
  }
  .tag-start        { background: #1f6feb33; color: #58a6ff; }
  .tag-reasoning    { background: #8957e533; color: #bc8cff; }
  .tag-command      { background: #d2992233; color: #e3b341; }
  .tag-command_result { background: #23863533; color: #3fb950; }
  .tag-file_change  { background: #da368833; color: #f778ba; }
  .tag-message      { background: #30363d; color: #c9d1d9; }
  .tag-end          { background: #1f6feb33; color: #58a6ff; }
  .tag-error        { background: #f8514933; color: #f85149; }
  .content { white-space: pre-wrap; word-break: break-word; flex: 1; }

  .empty-state {
    text-align: center; padding: 80px 20px; color: #484f58;
    flex: 1; display: flex; flex-direction: column; justify-content: center;
  }
  .empty-state h2 { font-size: 16px; margin-bottom: 8px; color: #8b949e; }
</style>
</head>
<body>
<div id="header">
  <h1>Codex Dev Progress</h1>
  <div class="header-right">
    <button id="clear-btn">Clear</button>
    <span id="conn-status" class="disconnected">disconnected</span>
  </div>
</div>
<div id="container">
  <div id="sidebar">
    <div id="sidebar-header">Operations</div>
    <div id="sidebar-list"></div>
  </div>
  <div id="main">
    <div class="empty-state" id="empty">
      <h2>Waiting for events...</h2>
      <p>Start a write or review operation to see progress here.</p>
    </div>
  </div>
</div>
<script>
(function() {
  const sidebarList = document.getElementById('sidebar-list');
  const main = document.getElementById('main');
  const connStatus = document.getElementById('conn-status');
  const clearBtn = document.getElementById('clear-btn');
  let emptyEl = document.getElementById('empty');

  // Operation data: operationId -> { label, desc, status, createdAt, entries[], sidebarEl, dotEl }
  const ops = new Map();
  let selectedOpId = null;
  let autoFollow = true; // auto-switch to latest active operation

  const STALE_TIMEOUT = 60000;

  function inferLabel(opId) {
    if (opId.includes('spec')) return 'Spec Review';
    if (opId.includes('quality')) return 'Quality Review';
    if (opId.startsWith('write')) return 'Write';
    if (opId.startsWith('review')) return 'Review';
    return 'Operation';
  }

  function formatTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
    } catch { return ts; }
  }

  function formatShortTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }

  // Extract short description from start event content
  function extractDesc(content) {
    if (!content) return '';
    // Remove [type] prefix
    const cleaned = content.replace(/^\\[\\w+\\]\\s*/, '');
    return cleaned.length > 50 ? cleaned.slice(0, 47) + '...' : cleaned;
  }

  function createOperation(opId, firstEvent) {
    if (emptyEl && emptyEl.parentNode) {
      emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
    }

    const label = inferLabel(opId);
    const desc = extractDesc(firstEvent.content);
    const createdAt = firstEvent.timestamp;

    // Create sidebar item
    const item = document.createElement('div');
    item.className = 'sidebar-item';

    const dot = document.createElement('span');
    dot.className = 'dot dot-running';

    const info = document.createElement('div');
    info.className = 'sidebar-info';

    const labelEl = document.createElement('div');
    labelEl.className = 'sidebar-label';
    labelEl.textContent = label;

    const meta = document.createElement('div');
    meta.className = 'sidebar-meta';

    const timeEl = document.createElement('span');
    timeEl.className = 'sidebar-time';
    timeEl.textContent = formatShortTime(createdAt);

    const descEl = document.createElement('span');
    descEl.className = 'sidebar-desc';
    descEl.textContent = desc;

    meta.appendChild(timeEl);
    if (desc) meta.appendChild(descEl);
    info.appendChild(labelEl);
    info.appendChild(meta);
    item.appendChild(dot);
    item.appendChild(info);

    // Insert at top (newest first)
    if (sidebarList.firstChild) {
      sidebarList.insertBefore(item, sidebarList.firstChild);
    } else {
      sidebarList.appendChild(item);
    }

    const op = {
      label,
      desc,
      status: 'running',
      createdAt,
      entries: [],
      sidebarEl: item,
      dotEl: dot,
      autoScroll: true,
    };
    ops.set(opId, op);

    item.addEventListener('click', function() {
      autoFollow = false;
      selectOperation(opId);
    });

    // Auto-follow: select new active operation
    if (autoFollow) {
      selectOperation(opId);
    }

    return op;
  }

  function selectOperation(opId) {
    selectedOpId = opId;

    // Update sidebar active state
    for (const [id, op] of ops) {
      op.sidebarEl.classList.toggle('active', id === opId);
    }

    renderMainView();
  }

  function renderMainView() {
    const op = ops.get(selectedOpId);
    if (!op) return;

    main.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.id = 'main-header';

    const dot = document.createElement('span');
    dot.className = 'dot';
    if (op.status === 'running') dot.className += ' dot-running';
    else if (op.status === 'failed') dot.className += ' dot-failed';
    else dot.className += ' dot-done';

    const label = document.createElement('span');
    label.id = 'main-label';
    label.textContent = op.label + (op.desc ? ' — ' + op.desc : '');

    const statusBadge = document.createElement('span');
    statusBadge.id = 'main-status';
    if (op.status === 'running') {
      statusBadge.className = 'status-running';
      statusBadge.textContent = 'running';
    } else if (op.status === 'failed') {
      statusBadge.className = 'status-failed';
      statusBadge.textContent = 'failed';
    } else {
      statusBadge.className = 'status-done';
      statusBadge.textContent = 'done';
    }

    header.appendChild(dot);
    header.appendChild(label);
    header.appendChild(statusBadge);
    main.appendChild(header);

    // Body
    const body = document.createElement('div');
    body.id = 'main-body';

    for (const entry of op.entries) {
      body.appendChild(createEntryEl(entry));
    }

    main.appendChild(body);

    // Scroll to bottom
    if (op.autoScroll) {
      requestAnimationFrame(function() {
        body.scrollTop = body.scrollHeight;
      });
    }

    // Track scroll
    body.addEventListener('scroll', function() {
      const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
      op.autoScroll = atBottom;
    });
  }

  function createEntryEl(entry) {
    const row = document.createElement('div');
    row.className = 'entry';

    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = formatTime(entry.timestamp);

    const tag = document.createElement('span');
    tag.className = 'tag tag-' + entry.type;
    tag.textContent = entry.type;

    const content = document.createElement('span');
    content.className = 'content';
    content.textContent = entry.content;

    row.appendChild(ts);
    row.appendChild(tag);
    row.appendChild(content);
    return row;
  }

  function appendEntry(opId, evt) {
    const op = ops.get(opId);
    if (!op) return;

    op.entries.push(evt);

    // If this operation is selected, append to DOM directly (avoid full re-render)
    if (selectedOpId === opId) {
      const body = document.getElementById('main-body');
      if (body) {
        body.appendChild(createEntryEl(evt));
        if (op.autoScroll) {
          body.scrollTop = body.scrollHeight;
        }
      }
    }
  }

  function updateStatus(opId, newStatus) {
    const op = ops.get(opId);
    if (!op) return;
    op.status = newStatus;

    // Update sidebar dot
    op.dotEl.className = 'dot dot-' + newStatus;

    // Update main view if selected
    if (selectedOpId === opId) {
      const statusBadge = document.getElementById('main-status');
      const mainDot = main.querySelector('#main-header .dot');
      if (statusBadge) {
        statusBadge.className = 'status-' + newStatus;
        statusBadge.textContent = newStatus;
      }
      if (mainDot) {
        mainDot.className = 'dot dot-' + newStatus;
      }
    }

    // When an active op finishes and autoFollow is on, switch to the next active op
    if (autoFollow && newStatus !== 'running') {
      const nextActive = findLatestActive();
      if (nextActive) selectOperation(nextActive);
    }
  }

  function findLatestActive() {
    // Find the most recently created active operation
    let latest = null;
    let latestTime = 0;
    for (const [id, op] of ops) {
      if (op.status === 'running') {
        const t = new Date(op.createdAt).getTime();
        if (t > latestTime) {
          latestTime = t;
          latest = id;
        }
      }
    }
    return latest;
  }

  function handleEvent(evt) {
    let op = ops.get(evt.operationId);

    if (!op) {
      // Clean up stale operations before creating new one
      cleanupStale();
      op = createOperation(evt.operationId, evt);
    }

    op.lastEventTime = Date.now();

    // Update operation status
    if (evt.type === 'end') {
      const failed = evt.content === 'failed';
      updateStatus(evt.operationId, failed ? 'failed' : 'done');
    } else if (evt.type === 'error') {
      updateStatus(evt.operationId, 'failed');
    }

    appendEntry(evt.operationId, evt);
  }

  function cleanupStale() {
    const now = Date.now();
    const toRemove = [];
    for (const [id, op] of ops) {
      if (op.status === 'running' && op.lastEventTime && (now - op.lastEventTime > STALE_TIMEOUT)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      const op = ops.get(id);
      if (op && op.sidebarEl.parentNode) {
        op.sidebarEl.parentNode.removeChild(op.sidebarEl);
      }
      ops.delete(id);
      if (selectedOpId === id) {
        selectedOpId = null;
        main.innerHTML = '<div class="empty-state"><h2>Select an operation</h2><p>Click an item in the sidebar to view its progress.</p></div>';
      }
    }
  }

  clearBtn.addEventListener('click', function() {
    ops.clear();
    sidebarList.innerHTML = '';
    selectedOpId = null;
    autoFollow = true;
    main.innerHTML = '<div class="empty-state" id="empty"><h2>Waiting for events...</h2><p>Start a write or review operation to see progress here.</p></div>';
    emptyEl = document.getElementById('empty');
  });

  function connect() {
    const es = new EventSource('/events');

    es.onopen = function() {
      connStatus.textContent = 'connected';
      connStatus.className = 'connected';
    };

    es.addEventListener('progress', function(e) {
      try {
        const evt = JSON.parse(e.data);
        handleEvent(evt);
      } catch {}
    });

    es.onerror = function() {
      connStatus.textContent = 'disconnected';
      connStatus.className = 'disconnected';
      es.close();
      setTimeout(connect, 2000);
    };
  }

  connect();
})();
</script>
</body>
</html>`;
}
