// Entry Sync - popup.js
// Toolbar popup for status display and monitoring

// ===== DOM Refs =====
const $ = (id) => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const projectIdLabel = $('projectIdLabel');
const serverLabel = $('serverLabel');
const newProjectToast = $('newProjectToast');
const btnSettings = $('btnSettings');
const btnBack = $('btnBack');
const btnPower = $('btnPower');
const statusBarMain = $('statusBarMain');
const statusBarSettings = $('statusBarSettings');
const mainView = $('mainView');
const settingsView = $('settingsView');
const toggleUpdateNotice = $('toggleUpdateNotice');
const toggleStatusBadge = $('toggleStatusBadge');

// ===== State =====
let currentProjectId = null;
let currentIsEntryPage = false;
let globalEntrySyncEnabled = true;
let toastTimer = null;

function showSettingsView() {
  if (statusBarMain) statusBarMain.style.display = 'none';
  if (statusBarSettings) statusBarSettings.style.display = 'flex';
  if (mainView) mainView.style.display = 'none';
  if (settingsView) settingsView.style.display = 'block';
}

function showMainView() {
  if (statusBarSettings) statusBarSettings.style.display = 'none';
  if (statusBarMain) statusBarMain.style.display = 'flex';
  if (settingsView) settingsView.style.display = 'none';
  if (mainView) mainView.style.display = 'block';
}

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

// ===== Power State Control =====
function refreshActiveTabStatus() {
  if (!globalEntrySyncEnabled) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      setStatus('waiting');
      updateRecognition({ isEntryPage: false });
      return;
    }

    const isEntryPage = tab.url.includes('playentry.org') || tab.url.includes('space.playentry.org');
    currentIsEntryPage = isEntryPage;
    const projectId = extractProjectId(tab.url);
    if (projectId) currentProjectId = projectId;

    if (!isEntryPage) {
      setStatus('waiting');
      updateRecognition({ isEntryPage: false });
      return;
    }

    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_SYNC_STATUS' }, (response) => {
        if (!globalEntrySyncEnabled) return;
        if (chrome.runtime.lastError || !response) {
          setStatus('waiting');
          updateRecognition({ entryReady: false, hasSyncVars: false, isEntryPage: true });
          return;
        }
        const effectiveRoomId = response.roomId || currentProjectId;
        if (effectiveRoomId) {
          currentProjectId = effectiveRoomId;
          if (projectIdLabel) projectIdLabel.textContent = effectiveRoomId;
        }
        if (response.serverUrl) updateServerLabel(response.serverUrl);
        if (response.connected) {
          setStatus('connected');
        } else if (response.isGameRunning) {
          setStatus('error');
        } else {
          setStatus('waiting');
        }
        updateRecognition({
          isEntryPage: true,
          entryReady: true,
          hasSyncVars: response.hasSyncVars,
          vars: response.vars || {},
          lists: response.lists || []
        });
      });
    }
  });
}

function renderPowerState(enabled) {
  globalEntrySyncEnabled = enabled;
  if (btnPower) {
    const powerText = $('powerText');
    if (enabled) {
      btnPower.className = 'power-btn';
      btnPower.title = 'Entry Sync 끄기';
      if (powerText) powerText.textContent = 'SYNC ON';
    } else {
      btnPower.className = 'power-btn off';
      btnPower.title = 'Entry Sync 켜기';
      if (powerText) powerText.textContent = 'SYNC OFF';
    }
  }
  if (mainView) {
    if (!enabled) {
      mainView.classList.add('is-disabled');
      setStatus('disabled');
      updateRecognition({ isEntryPage: currentIsEntryPage, isDisabled: true });
    } else {
      mainView.classList.remove('is-disabled');
      refreshActiveTabStatus();
    }
  }
}

function toggleGlobalPowerState(newEnabled) {
  chrome.storage.local.set({ entry_sync_enabled: newEnabled }, () => {
    renderPowerState(newEnabled);
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: 'ENTRY_SYNC_TOGGLE_ENABLED',
          enabled: newEnabled
        }).catch(() => {});
      }
    });
  });
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
    disabled:   '기능 꺼짐',
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
function updateRecognition(msg = {}) {
  const container = document.getElementById('recognitionStatus');
  if (!container) return;

  if (!globalEntrySyncEnabled || msg.isDisabled) {
    container.innerHTML = `
      <div class="monitor-card">
        <div class="monitor-left">
          <span class="material-symbols-outlined monitor-icon gray">power_off</span>
          <div class="monitor-info">
            <span class="monitor-title">작품 감지</span>
            <span class="monitor-subtitle gray">Entry Sync 꺼짐</span>
          </div>
        </div>
        <span class="monitor-badge pink">Disabled</span>
      </div>`;
    return;
  }

  const isEntryPage = msg.isEntryPage !== undefined ? msg.isEntryPage : currentIsEntryPage;
  const vars = msg.vars || {};
  const lists = msg.lists || [];

  let iconClass;
  let subtitle;
  let subtitleClass;

  if (!isEntryPage || !currentProjectId) {
    iconClass = 'gray';
    subtitle = '대기 중';
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

  if (!isEntryPage || !currentProjectId) {
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

  // Load global power state
  chrome.storage.local.get(['entry_sync_enabled'], (res) => {
    const isEnabled = res.entry_sync_enabled !== false;
    renderPowerState(isEnabled);
  });

  // Storage listener for state synchronization
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.entry_sync_enabled !== undefined) {
        renderPowerState(changes.entry_sync_enabled.newValue !== false);
      }
    });
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.url) {
      if (projectIdLabel) projectIdLabel.textContent = '—';
      setStatus('waiting');
      updateRecognition({ isEntryPage: false });
      chrome.runtime.sendMessage({ type: 'POPUP_OPENED' }).catch(() => {});
      return;
    }

    const isEntryPage = tab.url.includes('playentry.org') || tab.url.includes('space.playentry.org');
    currentIsEntryPage = isEntryPage;

    const projectId = extractProjectId(tab.url);
    currentProjectId = projectId;
    if (projectId && projectIdLabel) {
      projectIdLabel.textContent = projectId;
    } else if (projectIdLabel) {
      projectIdLabel.textContent = '—';
    }

    if (!isEntryPage) {
      setStatus('waiting');
      updateRecognition({ isEntryPage: false });
      return;
    }

    // Request status directly from content script on the active tab (works for URL projects & World modal popups)
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, { action: 'GET_SYNC_STATUS' }, (response) => {
        if (chrome.runtime.lastError || !response) {
          setStatus('waiting');
          updateRecognition({ entryReady: false, hasSyncVars: false, isEntryPage: true });
          return;
        }
        const effectiveRoomId = response.roomId || currentProjectId;
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
          isEntryPage: true,
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

  // ===== Power Button Handler =====
  btnPower?.addEventListener('click', () => {
    toggleGlobalPowerState(!globalEntrySyncEnabled);
  });

  // ===== Settings View Navigation =====
  btnSettings?.addEventListener('click', showSettingsView);
  btnBack?.addEventListener('click', showMainView);

  // ===== Settings Storage Sync =====
  if (toggleUpdateNotice) {
    chrome.storage.local.get('update_notice_enabled', (res) => {
      const isEnabled = res.update_notice_enabled !== false;
      toggleUpdateNotice.checked = isEnabled;
    });

    toggleUpdateNotice.addEventListener('change', () => {
      chrome.storage.local.set({ update_notice_enabled: toggleUpdateNotice.checked });
    });
  }

  if (toggleStatusBadge) {
    chrome.storage.local.get('status_badge_enabled', (res) => {
      const isEnabled = res.status_badge_enabled !== false; // Default ON
      toggleStatusBadge.checked = isEnabled;
    });

    toggleStatusBadge.addEventListener('change', () => {
      const isChecked = toggleStatusBadge.checked;
      chrome.storage.local.set({ status_badge_enabled: isChecked });

      // Notify active tab immediately
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, {
            type: 'ENTRY_SYNC_CONFIG_UPDATE',
            status_badge_enabled: isChecked
          }).catch(() => {});
        }
      });
    });
  }

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
