/**
 * Entry Sync - Unified content.js (Content Script)
 * 
 * Responsibilities:
 * 1. Extract unique Entry Room ID from iframe or URL
 * 2. Inject inject.js into page context
 * 3. Manage WebSocket lifecycle on game run/stop/unload
 * 4. Relay real-time messages (!!, ?!) and snapshot persistence (??)
 * 5. Provide synchronization status and variable recognition for popup
 */
(function () {
    let ws = null;
    let currentRoomId = null;
    let initialDataCache = null;
    let isGameRunning = false;
    let isIntentionalClose = false;
    let cloudflareServerUrl = 'wss://entry-sync.entry-sync.workers.dev/ws'; // Default WebSocket endpoint

    let cachedInspection = {
        hasSyncVars: false,
        vars: {},
        lists: []
    };

    // Tab ID unique per browser tab (survives refreshes in same tab via sessionStorage)
    let tabId = null;
    try {
        tabId = sessionStorage.getItem('entry_sync_tab_id');
        if (!tabId) {
            tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
            sessionStorage.setItem('entry_sync_tab_id', tabId);
        }
    } catch (e) {
        tabId = 'tab_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
    }

    // 1. Extract Unique Entry ID
    function extractEntryId() {
        // Method A: Check iframe src matching /iframe/고유넘버
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            const src = iframe.getAttribute('src') || '';
            const match = src.match(/\/iframe\/([a-zA-Z0-9_-]+)/);
            if (match && match[1]) {
                return match[1];
            }
        }

        // Method B: URL pattern matching
        const currentUrl = window.location.href;
        const wsMatch = currentUrl.match(/playentry\.org\/ws\/([a-zA-Z0-9_-]+)/);
        if (wsMatch && wsMatch[1]) return wsMatch[1];

        const projMatch = currentUrl.match(/playentry\.org\/project\/([a-zA-Z0-9_-]+)/);
        if (projMatch && projMatch[1]) return projMatch[1];

        const worldMatch = currentUrl.match(/space\.playentry\.org\/world\/([a-zA-Z0-9_-]+)/);
        if (worldMatch && worldMatch[1]) return worldMatch[1];

        try {
            const u = new URL(currentUrl);
            const param = u.searchParams.get('project');
            if (param) return param;
        } catch (e) {}

        return null;
    }

    const isTopFrame = window === window.top;

    // Load serverUrl from storage
    if (isTopFrame) {
        if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['serverUrl'], function (result) {
                if (result && result.serverUrl) {
                    cloudflareServerUrl = result.serverUrl;
                }
                initSync();
            });
        } else {
            initSync();
        }
    }

    // 2. Inject inject.js into page context
    function injectScript() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.onload = function () {
            this.remove();
        };
        (document.head || document.documentElement).appendChild(script);
    }

    injectScript();

    // Helper: Broadcast message to current window and all child iframes
    function broadcastToFrames(msgObj) {
        window.postMessage(msgObj, '*');
        document.querySelectorAll('iframe').forEach(f => {
            try {
                if (f.contentWindow) {
                    f.contentWindow.postMessage(msgObj, '*');
                }
            } catch (e) {}
        });
    }

    // 3. Connect to Cloudflare Worker WebSocket
    function connectWebSocket(roomId) {
        if (!roomId) return;
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        try {
            const connectUrl = `${cloudflareServerUrl}?room=${encodeURIComponent(roomId)}&tab=${encodeURIComponent(tabId)}`;
            console.log(`[EntrySync Content] 🔌 Connecting to Cloudflare DO: ${connectUrl}`);
            ws = new WebSocket(connectUrl);

            ws.onopen = function () {
                console.log(`[EntrySync Content] ✅ Connected to Cloudflare Worker for room: ${roomId}`);
                broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: true });
                try {
                    if (chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ type: 'REALTIME_CONNECTED' }).catch(() => {});
                    }
                } catch (e) {}
            };

            ws.onmessage = function (event) {
                try {
                    const msg = JSON.parse(event.data);

                    // Initial Room Status & Data
                    if (msg.type === 'INIT_ROOM_STATUS') {
                        initialDataCache = msg.data || {};
                        console.log('[EntrySync Content] Initial room status & data received:', msg);
                        broadcastToFrames({
                            type: 'ENTRY_SYNC_APPLY_INITIAL_DATA',
                            connected: true,
                            payload: initialDataCache
                        });
                    }

                    // Real-time Single Variable Update from peer (!! or ?!)
                    if (msg.type === 'VAR_UPDATE') {
                        broadcastToFrames({
                            type: 'ENTRY_SYNC_REMOTE_VAR_UPDATE',
                            name: msg.name,
                            value: msg.value
                        });
                    }

                    // Real-time Single List Update from peer (!! or ?!)
                    if (msg.type === 'LIST_UPDATE') {
                        broadcastToFrames({
                            type: 'ENTRY_SYNC_REMOTE_LIST_UPDATE',
                            name: msg.name,
                            array: msg.array
                        });
                    }

                    // Full Sync Update
                    if (msg.type === 'FULL_SYNC_UPDATE') {
                        initialDataCache = msg.payload || {};
                        broadcastToFrames({
                            type: 'ENTRY_SYNC_APPLY_INITIAL_DATA',
                            connected: true,
                            payload: msg.payload
                        });
                    }

                    // Save Data Only ACK
                    if (msg.type === 'SAVE_DATA_ONLY_ACK') {
                        console.log('[EntrySync Content] ✅ SAVE_DATA_ONLY_ACK received from server. Safe to disconnect.');
                        disconnectWebSocket();
                        broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
                    }
                } catch (e) {
                    console.error('[EntrySync Content] Error parsing WS message:', e);
                }
            };

            ws.onclose = function () {
                console.log('[EntrySync Content] ❌ Cloudflare WebSocket closed.');
                broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
                try {
                    if (chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({ type: 'REALTIME_DISCONNECTED' }).catch(() => {});
                    }
                } catch (e) {}

                // Auto-reconnect ONLY if game is currently running and close was not intentional
                if (isGameRunning && currentRoomId && !isIntentionalClose) {
                    setTimeout(() => {
                        if (isGameRunning && currentRoomId && (!ws || ws.readyState === WebSocket.CLOSED)) {
                            connectWebSocket(currentRoomId);
                        }
                    }, 2500);
                }
            };

            ws.onerror = function (err) {
                console.error('[EntrySync Content] WebSocket Error:', err);
                broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
            };
        } catch (e) {
            console.error('[EntrySync Content] Failed to create WebSocket:', e);
            broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
        }
    }

    // Disconnect WebSocket
    function disconnectWebSocket() {
        isIntentionalClose = true;
        initialDataCache = null;
        if (ws) {
            console.log('[EntrySync Content] Closing Cloudflare WebSocket connection...');
            try {
                if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                    ws.close(1000, 'Game stopped or page unloaded');
                }
            } catch (e) {}
            ws = null;
        }
    }

    function initSync() {
        currentRoomId = extractEntryId();
        if (currentRoomId) {
            console.log('[EntrySync Content] Target Entry Room ID extracted:', currentRoomId);
            return;
        }

        let retryCount = 0;
        const maxRetries = 60;

        const observer = new MutationObserver(() => {
            const id = extractEntryId();
            if (id && id !== currentRoomId) {
                currentRoomId = id;
                observer.disconnect();
                clearInterval(retryInterval);
                console.log('[EntrySync Content] (observer) Found Room ID:', currentRoomId);
            }
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        }

        const retryInterval = setInterval(() => {
            retryCount++;
            const id = extractEntryId();
            if (id && id !== currentRoomId) {
                currentRoomId = id;
                observer.disconnect();
                clearInterval(retryInterval);
                console.log(`[EntrySync Content] (retry #${retryCount}) Found Room ID:`, currentRoomId);
            } else if (retryCount >= maxRetries) {
                observer.disconnect();
                clearInterval(retryInterval);
                console.warn('[EntrySync Content] Could not extract Entry Room ID after 30s.');
            }
        }, 500);
    }

    // 4. Relay Window Messages between inject.js and WebSocket
    window.addEventListener('message', function (event) {
        if (!event.data) return;

        // When Game Starts (Engine Run)
        if (event.data.type === 'ENTRY_SYNC_ENGINE_RUN') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            isGameRunning = true;
            isIntentionalClose = false;

            if (!currentRoomId) {
                currentRoomId = extractEntryId();
            }

            console.log('[EntrySync Content] 🚀 Game Started. Connecting to Cloudflare WebSocket...');
            if (currentRoomId) {
                connectWebSocket(currentRoomId);
            }
        }

        // When Game Stops (Engine Stop)
        if (event.data.type === 'ENTRY_SYNC_ENGINE_STOP') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            isGameRunning = false;
            console.log('[EntrySync Content] ⏹️ Game stopped.');

            // Save ?? Data Only snapshot if available
            if (event.data.dataOnlySnapshot && ws && ws.readyState === WebSocket.OPEN) {
                console.log('[EntrySync Content] 💾 Sending ?? Data Only snapshot before disconnect...', event.data.dataOnlySnapshot);
                try {
                    ws.send(JSON.stringify({
                        type: 'SAVE_DATA_ONLY',
                        payload: event.data.dataOnlySnapshot,
                        syncData: event.data.syncDataSnapshot || null
                    }));
                } catch (e) {
                    console.error('[EntrySync Content] Error sending SAVE_DATA_ONLY:', e);
                }
                // Fallback disconnect after 1200ms if ACK not received
                setTimeout(() => {
                    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
                        disconnectWebSocket();
                        broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
                    }
                }, 1200);
            } else {
                disconnectWebSocket();
                broadcastToFrames({ type: 'ENTRY_SYNC_STATUS_UPDATE', connected: false });
            }
        }

        // Page Unload
        if (event.data.type === 'ENTRY_SYNC_PAGE_UNLOAD') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            isGameRunning = false;
            if (event.data.dataOnlySnapshot && ws && ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'SAVE_DATA_ONLY',
                        payload: event.data.dataOnlySnapshot,
                        syncData: event.data.syncDataSnapshot || null
                    }));
                } catch (e) {}
            }
            disconnectWebSocket();
        }

        // Realtime Variable Change (!! or ?!)
        if (event.data.type === 'ENTRY_SYNC_VAR_CHANGED') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'VAR_CHANGE',
                    name: event.data.name,
                    value: event.data.value
                }));
            }
        }

        // Realtime List Change (!! or ?!)
        if (event.data.type === 'ENTRY_SYNC_LIST_CHANGED') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'LIST_CHANGE',
                    name: event.data.name,
                    array: event.data.array
                }));
            }
        }

        // Inspection Response from inject.js
        if (event.data.type === 'RESP_ENTRY_VARS_INSPECTION') {
            if (event.data.inspection) {
                cachedInspection = event.data.inspection;
                try {
                    if (chrome.runtime && chrome.runtime.sendMessage) {
                        chrome.runtime.sendMessage({
                            type: 'SYNC_VARS_UPDATE',
                            entryReady: true,
                            projectId: currentRoomId,
                            isNewProject: currentRoomId === 'new',
                            hasSyncVars: cachedInspection.hasSyncVars,
                            vars: cachedInspection.vars,
                            lists: cachedInspection.lists,
                            realtimeConnected: ws && ws.readyState === WebSocket.OPEN
                        }).catch(() => {});
                    }
                } catch (e) {}
            }
        }
    });

    // Page Unload / Refresh Handlers
    window.addEventListener('beforeunload', function () {
        isGameRunning = false;
        disconnectWebSocket();
    });

    window.addEventListener('pagehide', function () {
        isGameRunning = false;
        disconnectWebSocket();
    });

    window.addEventListener('pageshow', function () {
        currentRoomId = extractEntryId();
        if (isGameRunning && currentRoomId && (!ws || ws.readyState === WebSocket.CLOSED)) {
            console.log('[EntrySync Content] 🔄 Page restored. Reconnecting WebSocket...');
            isIntentionalClose = false;
            connectWebSocket(currentRoomId);
        }
    });

    // 5. Popup Message Listener
    if (chrome && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'GET_SYNC_STATUS') {
                const detectedRoomId = currentRoomId || extractEntryId();
                const isWsOpen = ws && ws.readyState === WebSocket.OPEN;
                sendResponse({
                    success: true,
                    roomId: detectedRoomId,
                    isNewProject: detectedRoomId === 'new',
                    connected: isWsOpen,
                    isGameRunning: isGameRunning,
                    serverUrl: cloudflareServerUrl,
                    hasSyncVars: cachedInspection.hasSyncVars,
                    vars: cachedInspection.vars,
                    lists: cachedInspection.lists
                });
                return true;
            }

            if (request.type === 'POPUP_OPENED') {
                broadcastToFrames({ type: 'REQ_ENTRY_VARS_INSPECTION' });
            }

            return true;
        });
    }

})();
