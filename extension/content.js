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
    let entrySyncEnabled = true;
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

    
    // Helper to validate whether an extracted ID is a real Entry project ID (and not a URL path keyword like 'list', 'search', etc.)
    function isValidEntryId(id) {
        if (!id || typeof id !== 'string') return false;
        const lower = id.trim().toLowerCase();
        if (lower === 'new') return false;

        const reservedKeywords = [
            'list', 'all', 'search', 'rank', 'ranking', 'community',
            'popular', 'category', 'notice', 'guide', 'create', 'explore'
        ];
        if (reservedKeywords.includes(lower)) return false;

        // Valid Entry project ID: 24-character hexadecimal ObjectId or 12+ character alphanumeric string
        return /^[a-fA-F0-9]{24}$/.test(id) || /^[a-zA-Z0-9_-]{12,}$/.test(id);
    }

    // Helper to verify if snapshot object actually contains persistent variables/lists
    function hasSnapshotData(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return false;
        const hasVars = snapshot.variables && Object.keys(snapshot.variables).length > 0;
        const hasLists = snapshot.lists && Object.keys(snapshot.lists).length > 0;
        return hasVars || hasLists;
    }

    let cachedCurrentUserId = null;
    let cachedProjectAuthorId = null;

    async function fetchProjectAuthorId(roomId) {
        if (!roomId || roomId === 'new') return null;
        try {
            // Step 1: Fetch current page HTML to extract CSRF token
            // (_csrf cookie is HttpOnly so not accessible via document.cookie)
            let csrfToken = '';
            try {
                const htmlRes = await fetch(window.location.href, { credentials: 'include' });
                if (htmlRes.ok) {
                    const html = await htmlRes.text();
                    const m = html.match(/csrfToken["']?\s*[:=]\s*["']([^"']+)["']/i);
                    if (m) csrfToken = m[1];
                }
            } catch (e) {}

            // Step 2: POST to GraphQL with CSRF token
            const res = await fetch('https://playentry.org/graphql', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/json',
                    'csrf-token': csrfToken,
                    'x-csrf-token': csrfToken
                },
                body: JSON.stringify({
                    query: `query SELECT_PROJECT($id: ID!) { project(id: $id) { id user { id } } }`,
                    variables: { id: roomId }
                })
            });
            if (res.ok) {
                const data = await res.json();
                return data?.data?.project?.user?.id || null;
            }
        } catch (e) {}
        return null;
    }

    async function checkIsAuthorAuthorized(roomId, eventData) {
        const isWs = eventData?.isWorkspacePage !== undefined ? eventData.isWorkspacePage : window.location.href.includes('/ws/');
        if (!isWs) return true; // Play pages (/project/) allow data saves for all users

        const currentUserId = eventData?.currentUserId || cachedCurrentUserId;
        let authorId = eventData?.projectAuthorId || cachedProjectAuthorId;

        if (currentUserId) cachedCurrentUserId = currentUserId;

        if (!authorId && roomId) {
            authorId = await fetchProjectAuthorId(roomId);
            if (authorId) cachedProjectAuthorId = authorId;
        }

        if (currentUserId && authorId) {
            const isMatch = (currentUserId === authorId);
            if (!isMatch) {
                console.log(`[EntrySync Content] 🛡️ Workspace save blocked: Logged-in user (${currentUserId}) != Project Author (${authorId})`);
            }
            return isMatch;
        }
        return true;
    }

    // 1. Extract Unique Entry ID
    function extractEntryId() {
        // Priority 1: Check World popup iframe (#popupStyle > div > div > iframe)
        try {
            const popupIframe = document.querySelector('#popupStyle iframe, #popupStyle > div > div > iframe, iframe[title="작품"], iframe[src*="/iframe/"]');
            if (popupIframe) {
                const src = popupIframe.getAttribute('src') || popupIframe.src || popupIframe.getAttribute('data-src') || '';
                const match = src.match(/\/iframe\/([a-zA-Z0-9_-]+)/);
                if (match && match[1] && isValidEntryId(match[1])) {
                    console.log(`[EntrySync Content] 🎯 Extracted project ID from World popup iframe (#popupStyle): '${match[1]}'`);
                    return match[1];
                }
            }
        } catch (e) {}

        // Method A: Check window.location.href (if in top frame or inside iframe)
        const currentUrl = window.location.href;

        const pathMatch = currentUrl.match(/\/(?:iframe|project|ws|world|game)\/([a-zA-Z0-9_-]+)/);
        if (pathMatch && pathMatch[1] && isValidEntryId(pathMatch[1])) {
            return pathMatch[1];
        }

        try {
            const u = new URL(currentUrl);
            const param = u.searchParams.get('project') || u.searchParams.get('id');
            if (param && isValidEntryId(param)) return param;
        } catch (e) {}

        // Method B: Check all <iframe> elements in document (for World modals & embedded popups)
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            const src = iframe.getAttribute('src') || iframe.src || iframe.getAttribute('data-src') || '';
            if (!src) continue;

            const match = src.match(/\/(?:iframe|project|ws|world|game)\/([a-zA-Z0-9_-]+)/);
            if (match && match[1] && isValidEntryId(match[1])) {
                return match[1];
            }

            try {
                const u = new URL(src, window.location.href);
                const param = u.searchParams.get('project') || u.searchParams.get('id');
                if (param && isValidEntryId(param)) return param;
            } catch (e) {}
        }

        // Method C: Check modal links / elements on page (for World modal popups)
        const links = document.querySelectorAll('a[href*="/project/"], a[href*="/iframe/"], [data-project-id]');
        for (const link of links) {
            const dataId = link.getAttribute('data-project-id');
            if (dataId && isValidEntryId(dataId)) return dataId;

            const href = link.getAttribute('href') || '';
            const match = href.match(/\/(?:iframe|project|ws|world|game)\/([a-zA-Z0-9_-]+)/);
            if (match && match[1] && isValidEntryId(match[1])) {
                return match[1];
            }
        }

        return null;
    }

    const isTopFrame = window === window.top;

    // Broadcast config updates (serverUrl, status_badge_enabled, entry_sync_enabled) to inject.js
    function syncConfigToFrames() {
        if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['serverUrl', 'status_badge_enabled', 'entry_sync_enabled'], function (result) {
                if (result && result.serverUrl) {
                    cloudflareServerUrl = result.serverUrl;
                }
                entrySyncEnabled = result.entry_sync_enabled !== false;
                const isBadgeEnabled = result.status_badge_enabled !== false;
                broadcastToFrames({
                    type: 'ENTRY_SYNC_CONFIG_UPDATE',
                    status_badge_enabled: isBadgeEnabled,
                    entry_sync_enabled: entrySyncEnabled
                });
            });
        }
    }

    if (chrome && chrome.storage && chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, namespace) => {
            if (namespace === 'local' && (changes.status_badge_enabled || changes.entry_sync_enabled)) {
                if (changes.entry_sync_enabled !== undefined) {
                    entrySyncEnabled = changes.entry_sync_enabled.newValue !== false;
                    if (!entrySyncEnabled) {
                        disconnectWebSocket();
                    } else if (currentRoomId && currentRoomId !== 'new') {
                        connectWebSocket(currentRoomId);
                    }
                }
                broadcastToFrames({
                    type: 'ENTRY_SYNC_CONFIG_UPDATE',
                    status_badge_enabled: changes.status_badge_enabled ? changes.status_badge_enabled.newValue !== false : undefined,
                    entry_sync_enabled: entrySyncEnabled
                });
            }
        });
    }

    // Load serverUrl from storage
    if (isTopFrame) {
        if (chrome && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['serverUrl'], function (result) {
                if (result && result.serverUrl) {
                    cloudflareServerUrl = result.serverUrl;
                }
                syncConfigToFrames();
                initSync();
            });
        } else {
            initSync();
        }
    }

    // Helper: Parse current user ID and project author ID from __NEXT_DATA__ (top frame only)
    function parseAuthInfoFromPage() {
        try {
            const el = document.getElementById('__NEXT_DATA__');
            if (!el) return { currentUserId: null, projectAuthorId: null };
            const nextData = JSON.parse(el.textContent);
            const pageProps = nextData?.props?.pageProps || {};

            // Current logged-in user
            const commonUser = pageProps?.ipaddressBanned?.initialState?.common?.user
                            || pageProps?.initialState?.common?.user
                            || nextData?.props?.initialState?.common?.user
                            || null;
            const currentUserId = commonUser ? (commonUser._id || commonUser.id || null) : null;

            // Project author ID
            const project = pageProps?.project || pageProps?.initialState?.workspace?.project || null;
            const pUser = project?.user || null;
            const projectAuthorId = pUser ? (typeof pUser === 'object' ? (pUser._id || pUser.id || null) : pUser) : null;

            return { currentUserId, projectAuthorId };
        } catch (e) {
            return { currentUserId: null, projectAuthorId: null };
        }
    }

    async function broadcastAuthInfo() {
        if (!isTopFrame) return;
        const { currentUserId, projectAuthorId: parsedAuthorId } = parseAuthInfoFromPage();

        // If projectAuthorId not in __NEXT_DATA__, fetch from PlayEntry GraphQL
        let projectAuthorId = parsedAuthorId;
        if (!projectAuthorId) {
            const roomId = currentRoomId || extractEntryId();
            if (roomId && roomId !== 'new') {
                projectAuthorId = await fetchProjectAuthorId(roomId);
                if (projectAuthorId) cachedProjectAuthorId = projectAuthorId;
            }
        }

        broadcastToFrames({
            type: 'ENTRY_SYNC_AUTH_INFO',
            currentUserId,
            projectAuthorId
        });
    }

    // 2. Inject inject.js into page context
    function injectScript() {
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('inject.js');
        script.onload = function () {
            this.remove();
            // Send auth info to inject.js as soon as it loads (async - fetches GraphQL if needed)
            broadcastAuthInfo();
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
        if (!entrySyncEnabled) {
            console.log('[EntrySync Content] ⏸️ EntrySync is currently disabled by user.');
            return;
        }
        if (!roomId || roomId === 'new') {
            console.log(`[EntrySync Content] 🛑 Skipping WebSocket connect for roomId: '${roomId}'`);
            return;
        }
        const isWorkspacePage = window.location.href.includes('/ws/');
        if (!isWorkspacePage && !isGameRunning) {
            console.log(`[EntrySync Content] ⏸️ Skipping WebSocket connect for roomId '${roomId}' because game is not running on play/world page.`);
            return;
        }
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
                        console.log('[EntrySync Content] ✅ SAVE_DATA_ONLY_ACK received from server.');
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

                // Auto-reconnect ONLY IF game is currently running OR user is on workspace edit page (/ws/)
                const isWorkspacePage = window.location.href.includes('/ws/');
                if (currentRoomId && currentRoomId !== 'new' && !isIntentionalClose && (isGameRunning || isWorkspacePage)) {
                    setTimeout(() => {
                        if (currentRoomId && currentRoomId !== 'new' && (!ws || ws.readyState === WebSocket.CLOSED) && (isGameRunning || isWorkspacePage)) {
                            console.log('[EntrySync Content] 🔄 Auto-reconnecting WebSocket (active session)...');
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
                    ws.close(1000, 'Engine stopped');
                }
            } catch (e) {}
            ws = null;
        }
    }

    function initSync() {
        currentRoomId = extractEntryId();
        if (currentRoomId && currentRoomId !== 'new') {
            console.log('[EntrySync Content] Target Entry Room ID extracted:', currentRoomId);
            const isWorkspacePage = window.location.href.includes('/ws/');
            if (isWorkspacePage || isGameRunning) {
                connectWebSocket(currentRoomId);
            }
            return;
        }

        let retryCount = 0;
        const maxRetries = 60;

        const observer = new MutationObserver(() => {
            const id = extractEntryId();
            if (id && id !== 'new' && id !== currentRoomId) {
                currentRoomId = id;
                observer.disconnect();
                clearInterval(retryInterval);
                console.log('[EntrySync Content] (observer) Found Room ID:', currentRoomId);
                const isWorkspacePage = window.location.href.includes('/ws/');
                if (isWorkspacePage || isGameRunning) {
                    connectWebSocket(currentRoomId);
                }
            }
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        }

        const retryInterval = setInterval(() => {
            retryCount++;
            const id = extractEntryId();
            if (id && id !== 'new' && id !== currentRoomId) {
                currentRoomId = id;
                observer.disconnect();
                clearInterval(retryInterval);
                console.log(`[EntrySync Content] (retry #${retryCount}) Found Room ID:`, currentRoomId);
                const isWorkspacePage = window.location.href.includes('/ws/');
                if (isWorkspacePage || isGameRunning) {
                    connectWebSocket(currentRoomId);
                }
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

            console.log('[EntrySync Content] 🚀 Game Started. Ensuring latest data from Cloudflare WebSocket...');
            if (currentRoomId && currentRoomId !== 'new') {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log('[EntrySync Content] 🔄 WebSocket already connected. Requesting GET_LATEST_DATA...');
                    try {
                        ws.send(JSON.stringify({ 
                            type: 'GET_LATEST_DATA',
                            roomId: currentRoomId
                        }));
                    } catch (e) {
                        connectWebSocket(currentRoomId);
                    }
                } else {
                    connectWebSocket(currentRoomId);
                }
            }
        }

        // When Game Stops (Engine Stop) or Workspace Property Edited
        if (event.data.type === 'ENTRY_SYNC_ENGINE_STOP' || event.data.type === 'ENTRY_SYNC_SAVE_DATA_NOW') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }

            const isWsPage = event.data?.isWorkspacePage !== undefined ? event.data.isWorkspacePage : window.location.href.includes('/ws/');

            if (event.data.type === 'ENTRY_SYNC_ENGINE_STOP') {
                isGameRunning = false;
                console.log(`[EntrySync Content] ⏹️ Game stopped (isWorkspacePage: ${isWsPage}).`);
            }

            if (!currentRoomId) {
                currentRoomId = extractEntryId();
            }

            // Save ?? Data Only / ?! Sync Data snapshot if available
            const hasDataToSave = hasSnapshotData(event.data.dataOnlySnapshot) || hasSnapshotData(event.data.syncDataSnapshot);
            if (currentRoomId && currentRoomId !== 'new' && hasDataToSave && ws && ws.readyState === WebSocket.OPEN) {
                console.log(`[EntrySync Content] 💾 Sending snapshot save request to Cloudflare (roomId: ${currentRoomId}, isWorkspacePage: ${isWsPage})...`, event.data);
                try {
                    ws.send(JSON.stringify({
                        type: 'SAVE_DATA_ONLY',
                        userId: event.data?.currentUserId || cachedCurrentUserId || null,
                        isWorkspacePage: isWsPage,
                        roomId: currentRoomId,
                        payload: event.data.dataOnlySnapshot || null,
                        syncData: event.data.syncDataSnapshot || null
                    }));
                } catch (e) {
                    console.error('[EntrySync Content] Error sending SAVE_DATA_ONLY:', e);
                }
            }

            // Disconnect WebSocket on engine stop ONLY IF NOT on workspace page (/ws/)
            if (event.data.type === 'ENTRY_SYNC_ENGINE_STOP') {
                if (!isWsPage) {
                    setTimeout(() => {
                        console.log('[EntrySync Content] 🔌 Disconnecting WebSocket after game stop on play/world page...');
                        disconnectWebSocket();
                    }, 30);
                } else {
                    console.log('[EntrySync Content] ℹ️ Workspace page (/ws/): Keeping WebSocket connected after game stop.');
                }
            }
        }

        // Page Unload
        if (event.data.type === 'ENTRY_SYNC_PAGE_UNLOAD') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            isGameRunning = false;
            if (!currentRoomId) {
                currentRoomId = extractEntryId();
            }
            const hasUnloadDataToSave = hasSnapshotData(event.data.dataOnlySnapshot) || hasSnapshotData(event.data.syncDataSnapshot);
            if (currentRoomId && currentRoomId !== 'new' && hasUnloadDataToSave && ws && ws.readyState === WebSocket.OPEN) {
                const isWs = event.data?.isWorkspacePage !== undefined ? event.data.isWorkspacePage : window.location.href.includes('/ws/');
                try {
                    ws.send(JSON.stringify({
                        type: 'SAVE_DATA_ONLY',
                        userId: event.data?.currentUserId || cachedCurrentUserId || null,
                        isWorkspacePage: isWs,
                        roomId: currentRoomId,
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

        // inject.js requesting auth info (runs in iframe, can't access __NEXT_DATA__ directly)
        if (event.data.type === 'ENTRY_SYNC_REQUEST_AUTH_INFO') {
            broadcastAuthInfo();
        }

        // inject.js requesting config info
        if (event.data.type === 'ENTRY_SYNC_REQUEST_CONFIG') {
            syncConfigToFrames();
        }

        // inject.js toggling EntrySync ON/OFF state
        if (event.data.type === 'ENTRY_SYNC_TOGGLE_ENABLED') {
            if (!isTopFrame) {
                window.top.postMessage(event.data, '*');
                return;
            }
            const newEnabled = event.data.enabled !== false;
            entrySyncEnabled = newEnabled;
            if (chrome && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ entry_sync_enabled: newEnabled });
            }
            if (!newEnabled) {
                console.log('[EntrySync Content] ⏸️ EntrySync turned OFF via badge toggle.');
                disconnectWebSocket();
            } else if (currentRoomId && currentRoomId !== 'new') {
                console.log('[EntrySync Content] ▶️ EntrySync turned ON via badge toggle.');
                connectWebSocket(currentRoomId);
            }
            broadcastToFrames({
                type: 'ENTRY_SYNC_CONFIG_UPDATE',
                entry_sync_enabled: newEnabled
            });
        }

        // Child frame status report relayed to top frame
        if (event.data.type === 'ENTRY_SYNC_FRAME_STATUS_REPORT') {
            if (event.data.roomId && isValidEntryId(event.data.roomId)) {
                if (!currentRoomId || currentRoomId !== event.data.roomId) {
                    currentRoomId = event.data.roomId;
                    console.log(`[EntrySync Content] 🎯 Received Room ID from child frame: '${currentRoomId}'`);
                    connectWebSocket(currentRoomId);
                }
            }
            if (event.data.inspection) {
                cachedInspection = event.data.inspection;
            }
            if (event.data.isGameRunning !== undefined) {
                isGameRunning = event.data.isGameRunning;
            }
        }

        // Inspection Response from inject.js
        if (event.data.type === 'RESP_ENTRY_VARS_INSPECTION') {
            if (event.data.projectId && isValidEntryId(event.data.projectId)) {
                if (!currentRoomId || currentRoomId !== event.data.projectId) {
                    currentRoomId = event.data.projectId;
                    console.log(`[EntrySync Content] 🎯 Room ID updated from inject.js: '${currentRoomId}'`);
                    connectWebSocket(currentRoomId);
                }
            }
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

            // If running inside iframe, relay status report to top window
            if (!isTopFrame) {
                try {
                    window.top.postMessage({
                        type: 'ENTRY_SYNC_FRAME_STATUS_REPORT',
                        roomId: currentRoomId,
                        inspection: cachedInspection,
                        isGameRunning: isGameRunning,
                        connected: ws && ws.readyState === WebSocket.OPEN
                    }, '*');
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
                if (detectedRoomId && !currentRoomId) currentRoomId = detectedRoomId;
                const isWsOpen = ws && ws.readyState === WebSocket.OPEN;
                sendResponse({
                    success: true,
                    roomId: currentRoomId || null,
                    isNewProject: currentRoomId === 'new',
                    connected: isWsOpen,
                    isGameRunning: isGameRunning,
                    serverUrl: cloudflareServerUrl,
                    hasSyncVars: cachedInspection.hasSyncVars,
                    vars: cachedInspection.vars,
                    lists: cachedInspection.lists
                });

                // Request fresh inspection from inject.js across all frames
                broadcastToFrames({ type: 'REQ_ENTRY_VARS_INSPECTION' });
                return true;
            }

            if (request.type === 'POPUP_OPENED') {
                broadcastToFrames({ type: 'REQ_ENTRY_VARS_INSPECTION' });
                syncConfigToFrames();
            }

            if (request.type === 'ENTRY_SYNC_CONFIG_UPDATE') {
                broadcastToFrames({
                    type: 'ENTRY_SYNC_CONFIG_UPDATE',
                    status_badge_enabled: request.status_badge_enabled !== false
                });
            }

            return true;
        });
    }

    // Periodically inspect World popup modals (#popupStyle) for newly opened projects
    setInterval(() => {
        const detectedId = extractEntryId();
        if (detectedId && detectedId !== currentRoomId) {
            currentRoomId = detectedId;
            console.log(`[EntrySync Content] 🎯 World popup project detected: '${currentRoomId}'`);
            connectWebSocket(currentRoomId);
            broadcastToFrames({ type: 'REQ_ENTRY_VARS_INSPECTION' });
        }
    }, 1000);

})();

