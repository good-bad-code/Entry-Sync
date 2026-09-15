// Entry Sync - popup.js
// Toolbar popup for status display and monitoring

// ===== DOM Refs =====
const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const projectIdLabel = $('projectIdLabel');
const serverLabel = $('serverLabel');
const newProjectToast = $('newProjectToast');

// ===== State =====
let currentProjectId = null;
let toastTimer = null;

function showNewProjectToast() {
  if (!newProjectToast) return;
  newProjectToast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideNewProjectToast, 5000);
}

function hideNewProjectToast() {
  if (!newProjectToast) return;
  newProjectToast.classList.remove('visible');
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

// ===== Extension context guard =====
function isExtensionValid() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

// ===== extractProjectId =====
function extractProjectId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const projectMatch = u.pathname.match(/^\/project\/([a-zA-Z0-9_-]+)/);
    if (projectMatch) return projectMatch[1];
    const wsMatch = u.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)/);
    if (wsMatch) return wsMatch[1];
    const projectParam = u.searchParams.get('project');
    if (projectParam) return projectParam;
    return null;
  } catch {
    return null;
  }
}

// ===== Status Updates =====
function setStatus(state) {
  if (!statusDot || !statusText) return;
  statusDot.className = 'status-dot';
  statusDot.classList.add(state);
  const labels = {
    waiting:    '대기 중',
    connecting: '연결 중…',
    connected:  '연결됨',
    error:      '연결 불가',
  };
  statusText.textContent = labels[state] || '알 수 없음';
}

// ===== Server Label =====
function updateServerLabel(serverUrl) {
  if (!serverLabel) return;
  if (!serverUrl) { serverLabel.textContent = '미설정'; serverLabel.title = ''; return; }
  try {
    const u = new URL(serverUrl);
    // e.g. wss://entry-sync.entry-sync.workers.dev/ws -> hostname's first segment 'entry-sync'
    const serverName = u.hostname.split('.')[0] || u.hostname;
    serverLabel.textContent = serverName;
    serverLabel.title = serverUrl;
  } catch {
    const clean = serverUrl.replace(/^wss?:\/\//, '').split('/')[0];
    serverLabel.textContent = clean.split('.')[0] || clean;
    serverLabel.title = serverUrl;
  }
}

// ===== Update Recognition =====
function updateRecognition(msg) {
  const container = document.getElementById('recognitionStatus');
  if (!container) return;

  const vars = msg.vars || {};
  const lists = msg.lists || [];

  let iconClass;
  let subtitle;
  let subtitleClass;

  if (!currentProjectId) {
    iconClass = 'gray';
    subtitle = '-';
    subtitleClass = 'gray';
  } else if (!msg.entryReady) {
    iconClass = 'red';
    subtitle = '감지 불가';
    subtitleClass = 'red';
  } else {
    iconClass = 'green';
    subtitle = '감지 완료';
    subtitleClass = 'green';
  }

  // Count ??, !!, ?! prefixed variables & lists
  let syncVarCount = 0;
  if (typeof vars === 'object' && vars !== null) {
    syncVarCount = Object.keys(vars).filter(k => k.startsWith('??') || k.startsWith('!!') || k.startsWith('?!')).length;
  }
  if (Array.isArray(lists)) {
    syncVarCount += lists.filter(l => {
      const name = typeof l === 'string' ? l : (l && l.name);
      return name && (name.startsWith('??') || name.startsWith('!!') || name.startsWith('?!'));
    }).length;
  }

  let badgeClass;
  let badgeText;
  const hasSyncVars = msg.hasSyncVars;

  if (!currentProjectId) {
    badgeClass = 'gray';
    badgeText = '-';
  } else if (hasSyncVars === false) {
    badgeClass = 'pink';
    badgeText = 'DeActive';
  } else if (hasSyncVars === true) {
    badgeClass = 'blue';
    badgeText = 'Active';
  } else if (syncVarCount === 0) {
    badgeClass = 'pink';
    badgeText = 'DeActive';
  } else {
    badgeClass = 'blue';
    badgeText = 'Active';
  }

  const badgeHtml = `<span class="monitor-badge ${badgeClass}">${badgeText}</span>`;

  container.innerHTML = `
    <div class="monitor-card">
      <div class="monitor-left">
        <span class="material-symbols-outlined monitor-icon ${iconClass}">data_object</span>
        <div class="monitor-info">
          <span class="monitor-title">작품 감지</span>
          <span class="monitor-subtitle ${subtitleClass}">${subtitle}</span>
        </div>
      </div>
      ${badgeHtml}
    </div>`;
}


// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
  if (!isExtensionValid()) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      if (projectIdLabel) projectIdLabel.textContent = '—';
      setStatus('waiting');
      chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
      return;
    }

    const projectId = extractProjectId(tab.url);
    currentProjectId = projectId;
    if (projectId && projectIdLabel) {
      projectIdLabel.textContent = projectId;
    } else if (projectIdLabel) {
      projectIdLabel.textContent = '—';
    }

    // Request status directly from content script on the active tab
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_SYNC_STATUS' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          if (projectId) {
            setStatus('waiting');
            updateRecognition({ entryReady: false, hasSyncVars: false });
          }
          return;
        }
        const effectiveRoomId = response.roomId || projectId;
        if (effectiveRoomId) {
          currentProjectId = effectiveRoomId;
          if (projectIdLabel) projectIdLabel.textContent = effectiveRoomId;
        }
        if (response.isNewProject || response.roomId === 'new' || projectId === 'new') {
          showNewProjectToast();
        }
        if (response.serverUrl) {
          updateServerLabel(response.serverUrl);
        }
        if (response.connected) {
          setStatus('connected');
        } else if (response.isGameRunning) {
          setStatus('error');
        } else {
          setStatus('waiting');
        }
        updateRecognition({
          entryReady: true,
          hasSyncVars: response.hasSyncVars,
          vars: response.vars || {},
          lists: response.lists || []
        });
      });

      // Also trigger a fresh inspection on the page frames
      chrome.tabs.sendMessage(tab.id, { type: 'POPUP_OPENED' }, () => {
        if (chrome.runtime.lastError) {} // Ignore
      });
    }

    chrome.runtime.sendMessage({ type: 'POPUP_OPENED', projectId: projectId || undefined, tabId: tab.id }).catch(() => {});
  });


  // Toast click-to-dismiss
  newProjectToast?.addEventListener('click', hideNewProjectToast);

  // ===== Message Listener =====
  chrome.runtime.onMessage.addListener((message) => {
    try {
      const msg = message;
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'SYNC_VARS_UPDATE': {
          if (msg.realtimeConnected === true) {
            setStatus('connected');
          } else if (msg.realtimeConnected === false) {
            setStatus('error');
          } else if (msg.entryReady) {
            setStatus('connected');
          }
          if (msg.isNewProject) {
            showNewProjectToast();
          }
          if (msg.projectId && !currentProjectId) {
            currentProjectId = msg.projectId;
            if (projectIdLabel) projectIdLabel.textContent = msg.projectId;
          }
          updateRecognition(msg);
          break;
        }

        case 'REALTIME_CONNECTED':
          setStatus('connected');
          break;
        case 'REALTIME_DISCONNECTED':
          setStatus('error');
          break;

      }
    } catch (e) {
      console.error('[EntrySync:Popup] Error in message listener:', e);
    }
  });
});
