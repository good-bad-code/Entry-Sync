/**
 * Entry Sync - Unified inject.js (Page World Script)
 * 
 * Manages:
 * 1. Status Variable '?!' (0 -> 1 or -1 upon project run)
 * 2. '??' Data Only Variables/Lists (Firebase fetch on start, Firebase save on stop)
 * 3. '!!' Sync Only Variables/Lists (Real-time WebSocket sync, purged on 0 members)
 * 4. '?!' Sync + Data Variables/Lists (Real-time sync + Firebase persistence on 0 members)
 */
(function () {
    const PREFIX_DATA_ONLY = '??';
    const PREFIX_SYNC_ONLY = '!!';
    const PREFIX_SYNC_DATA = '?!';

    let isConnectedToCloudflare = false;
    let isApplyingRemote = false; // Flag to prevent broadcast echo loop
    let isGameStopping = false;   // Flag to prevent broadcasting during stop/reset sequence
    let isStartingUp = false;     // Flag to protect initial remote state on run
    let statusVarHooked = false;  // Flag to ensure status var hook is installed once
    let stopEventSent = false;    // Flag to prevent duplicate stop events (multi-hook dedup)

    let hookedVariables = new Set();
    let hookedLists = new Set();
    let pendingPayload = null;
    let isHooked = false;
    let latestDataOnly = { variables: {}, lists: {} }; // Tracks ?? variable state
    let latestSyncData = { variables: {}, lists: {} }; // Tracks ?! variable state

    // ===== Prefix Helpers =====
    function isStatusVar(name) {
        return name && typeof name === 'string' && name.trim() === PREFIX_SYNC_DATA; // Exactly "?!"
    }

    function isDataOnlyTarget(name) {
        return name && typeof name === 'string' && name.startsWith(PREFIX_DATA_ONLY) && name !== PREFIX_DATA_ONLY;
    }

    function isSyncOnlyTarget(name) {
        return name && typeof name === 'string' && name.startsWith(PREFIX_SYNC_ONLY) && name !== PREFIX_SYNC_ONLY;
    }

    function isSyncDataTarget(name) {
        return name && typeof name === 'string' && name.startsWith(PREFIX_SYNC_DATA) && name !== PREFIX_SYNC_DATA;
    }

    function isRealtimeTarget(name) {
        return isSyncOnlyTarget(name) || isSyncDataTarget(name);
    }

    function isAnyManagedTarget(name) {
        return isDataOnlyTarget(name) || isSyncOnlyTarget(name) || isSyncDataTarget(name) || isStatusVar(name);
    }

    // ===== 1. Update Connection Status Variable (?!) =====
    // Requirement 1: 작품 시작시 바로 ?! 자체인 변수의 값이 0 이라면 Cloudflare 의 연결 여부에 따라 1 또는 -1 로 바로 바꾸기
    function updateStatusVariable(connected) {
        isConnectedToCloudflare = connected;
        try {
            if (window.Entry && window.Entry.variableContainer && window.Entry.variableContainer.variables_) {
                const vc = window.Entry.variableContainer;
                const vars = Array.isArray(vc.variables_)
                    ? vc.variables_
                    : Object.values(vc.variables_);

                let found = false;
                vars.forEach(v => {
                    const name = v.name_ || v.name;
                    if (isStatusVar(name)) {
                        found = true;
                        const newStatusVal = connected ? 1 : -1;
                        // Temporarily bypass isApplyingRemote guard since this is intentional
                        const prevApplying = isApplyingRemote;
                        isApplyingRemote = true;
                        if (typeof v.setValue === 'function') {
                            v.setValue(newStatusVal);
                        }
                        v.value_ = newStatusVal;
                        v.value = newStatusVal;
                        isApplyingRemote = prevApplying;
                        if (typeof v.updateView === 'function') v.updateView();
                        if (typeof vc.updateViews === 'function') vc.updateViews();
                        console.log(`[EntrySync Inject] ⚡ Status Variable '${name}' updated: -> ${newStatusVal} (connected: ${connected})`);
                    }
                });
                if (!found) {
                    console.log(`[EntrySync Inject] ⚠️ No '?!' status variable found in project.`);
                }
            }
        } catch (e) {
            console.error('[EntrySync Inject] Error updating status variable:', e);
        }
    }

    // ===== 1a. Hook Status Variable to ENFORCE connection state (no Entry block can overwrite it) =====
    function hookStatusVariable() {
        if (statusVarHooked) return;
        if (!window.Entry || !window.Entry.variableContainer || !window.Entry.variableContainer.variables_) return;

        const vc = window.Entry.variableContainer;
        const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);

        vars.forEach(v => {
            const name = v.name_ || v.name;
            if (isStatusVar(name) && typeof v.setValue === 'function') {
                const originalSetValue = v.setValue;
                v.setValue = function (val) {
                    // If the call is NOT from our updateStatusVariable (isApplyingRemote),
                    // IGNORE it and enforce the current connection state instead.
                    if (!isApplyingRemote) {
                        const enforced = isConnectedToCloudflare ? 1 : -1;
                        console.log(`[EntrySync Inject] 🛡️ Blocked external setValue(${val}) on '${name}', enforcing ${enforced}`);
                        return originalSetValue.apply(this, [enforced]);
                    }
                    return originalSetValue.apply(this, arguments);
                };
                statusVarHooked = true;
                console.log(`[EntrySync Inject] 🔒 Status Variable '${name}' hook installed (external writes blocked).`);
            }
        });
    }

    // ===== 2. Real-time Hooks for !! and ?! Variables/Lists (and Memory tracking for ??) =====
    function setupSyncHooks() {
        if (!window.Entry || !window.Entry.variableContainer) return;
        const vc = window.Entry.variableContainer;

        // Hook Variables
        if (vc.variables_) {
            const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
            vars.forEach(v => {
                const name = v.name_ || v.name;
                const id = v.id_ || v.id;

                // Hook both real-time targets (!!*, ?!*) and persistent data targets (??*)
                if ((isRealtimeTarget(name) || isDataOnlyTarget(name)) && !hookedVariables.has(id)) {
                    hookedVariables.add(id);
                    const originalSetValue = v.setValue;
                    if (typeof originalSetValue === 'function') {
                        v.setValue = function (val) {
                            const ret = originalSetValue.apply(this, arguments);
                            const isEngineRunning = window.Entry &&
                                window.Entry.engine &&
                                window.Entry.engine.isState &&
                                window.Entry.engine.isState('run');

                            if (!isApplyingRemote && !isStartingUp && isEngineRunning) {
                                // Track ?? in real-time memory buffer
                                if (isDataOnlyTarget(name)) {
                                    latestDataOnly.variables[name] = val;
                                }
                                // Track ?! in real-time memory buffer (for save-on-stop)
                                if (isSyncDataTarget(name)) {
                                    latestSyncData.variables[name] = val;
                                }

                                // Broadcast !! and ?! in real-time to peers
                                if (isRealtimeTarget(name) && !isGameStopping) {
                                    window.postMessage({
                                        type: 'ENTRY_SYNC_VAR_CHANGED',
                                        name: name,
                                        value: val
                                    }, '*');
                                }
                            }
                            return ret;
                        };
                    }
                }
            });
        }

        // Hook Lists
        if (vc.lists_) {
            const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
            lists.forEach(l => {
                const name = l.name_ || l.name;
                const id = l.id_ || l.id;

                // Hook both real-time targets (!!*, ?!*) and persistent data targets (??*)
                if ((isRealtimeTarget(name) || isDataOnlyTarget(name)) && !hookedLists.has(id)) {
                    hookedLists.add(id);

                    function notifyListChange() {
                        if (isApplyingRemote || isStartingUp) return;
                        const isEngineRunning = window.Entry &&
                            window.Entry.engine &&
                            window.Entry.engine.isState &&
                            window.Entry.engine.isState('run');
                        if (!isEngineRunning) return;

                        const rawArr = l.array_ || l.array || (l.getArray ? l.getArray() : []);
                        const arr = Array.isArray(rawArr)
                            ? rawArr.map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                            : [];

                        // Track ?? in real-time memory buffer
                        if (isDataOnlyTarget(name)) {
                            latestDataOnly.lists[name] = arr;
                        }
                        // Track ?! in real-time memory buffer (for save-on-stop)
                        if (isSyncDataTarget(name)) {
                            latestSyncData.lists[name] = arr;
                        }

                        // Broadcast !! and ?! in real-time to peers
                        if (isRealtimeTarget(name) && !isGameStopping) {
                            window.postMessage({
                                type: 'ENTRY_SYNC_LIST_CHANGED',
                                name: name,
                                array: arr
                            }, '*');
                        }
                    }

                    const methodsToHook = ['appendValue', 'insertValue', 'deleteValue', 'replaceValue', 'setArray', 'setList'];
                    methodsToHook.forEach(methodName => {
                        if (typeof l[methodName] === 'function') {
                            const originalMethod = l[methodName];
                            l[methodName] = function () {
                                const ret = originalMethod.apply(this, arguments);
                                notifyListChange();
                                return ret;
                            };
                        }
                    });
                }
            });
        }
    }

    // ===== 3. Apply Remote Variable / List Updates =====
    function applyRemoteVar(name, value) {
        if (!name || isStatusVar(name) || !window.Entry || !window.Entry.variableContainer) return;
        const vc = window.Entry.variableContainer;
        if (!vc.variables_) return;

        isApplyingRemote = true;
        try {
            const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
            const target = vars.find(v => (v.name_ || v.name) === name);
            if (target) {
                if (typeof target.setValue === 'function') {
                    target.setValue(value);
                } else {
                    target.value = value;
                }
                if (typeof target.updateView === 'function') target.updateView();
                console.log(`[EntrySync Inject] 📥 Remote Var Applied: ${name} =`, value);
            }
        } finally {
            isApplyingRemote = false;
        }
    }

    function applyRemoteList(name, array) {
        if (!name || !window.Entry || !window.Entry.variableContainer) return;
        const vc = window.Entry.variableContainer;
        if (!vc.lists_) return;

        isApplyingRemote = true;
        try {
            const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
            const target = lists.find(l => (l.name_ || l.name) === name);
            if (target) {
                const rawArr = Array.isArray(array) ? array : [];
                // Entry list elements require { data: value } objects to render text in the list widget
                const arr = rawArr.map(item => {
                    if (typeof item === 'object' && item !== null && 'data' in item) return item;
                    return { data: item !== undefined && item !== null ? item : '' };
                });
                if (typeof target.setArray === 'function') {
                    target.setArray(arr);
                } else if (typeof target.setList === 'function') {
                    target.setList(arr);
                } else {
                    target.array_ = arr;
                    target.array = arr;
                }
                if (typeof target.updateView === 'function') target.updateView();
                console.log(`[EntrySync Inject] 📥 Remote List Applied: ${name} [${arr.length} items]`);
            }
        } finally {
            isApplyingRemote = false;
        }
    }

    // ===== 4. Apply Initial Payload (Data Only + Sync Only + Sync Data) =====
    function applyInitialData(payload, retryCount = 0) {
        if (!payload) {
            isStartingUp = false;
            return;
        }

        const vc = window.Entry && window.Entry.variableContainer;
        if (!vc || !vc.variables_) {
            if (retryCount < 10) {
                pendingPayload = payload;
                setTimeout(() => applyInitialData(payload, retryCount + 1), 200);
            }
            return;
        }

        pendingPayload = null;
        isApplyingRemote = true;

        try {
            const allVars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
            const allLists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);

            // Helper to apply variable map/array
            function applyVarsCollection(varsData) {
                if (!varsData) return;
                const items = Array.isArray(varsData)
                    ? varsData
                    : Object.entries(varsData).map(([name, value]) => ({ name, value }));
                // Do not overwrite Entry variables if server has no data for this room!
                if (items.length === 0) return;

                items.forEach(v => {
                    if (v.name && !isStatusVar(v.name) && v.value !== undefined && v.value !== null) {
                        const target = allVars.find(item => (item.name_ || item.name) === v.name);
                        if (target) {
                            if (typeof target.setValue === 'function') target.setValue(v.value);
                            else target.value = v.value;
                            target.value_ = v.value;
                            if (typeof target.updateView === 'function') target.updateView();
                            if (isDataOnlyTarget(v.name)) {
                                latestDataOnly.variables[v.name] = v.value;
                            }
                            // Also seed latestSyncData so ?! vars are saved even if unchanged
                            if (isSyncDataTarget(v.name)) {
                                latestSyncData.variables[v.name] = v.value;
                            }
                            console.log(`[EntrySync Inject] Initial Var Applied: ${v.name} =`, v.value);
                        }
                    }
                });
            }

            // Helper to apply list map/array
            function applyListsCollection(listsData) {
                if (!listsData) return;
                const items = Array.isArray(listsData)
                    ? listsData
                    : Object.entries(listsData).map(([name, array]) => ({ name, array }));
                // Do not overwrite Entry lists if server has no data for this room!
                if (items.length === 0) return;

                items.forEach(l => {
                    if (l.name) {
                        const target = allLists.find(item => (item.name_ || item.name) === l.name);
                        if (target) {
                            const rawArr = Array.isArray(l.array) ? l.array : (Array.isArray(l) ? l : []);
                            if (rawArr.length > 0) {
                                const cleanArr = rawArr
                                    .map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                    .filter(item => item !== null && item !== undefined);
                                const arr = cleanArr.map(item => ({ data: item }));
                                if (typeof target.setArray === 'function') target.setArray(arr);
                                else if (typeof target.setList === 'function') target.setList(arr);
                                else { target.array_ = arr; target.array = arr; }
                                if (typeof target.updateView === 'function') target.updateView();
                                if (isDataOnlyTarget(l.name)) {
                                    latestDataOnly.lists[l.name] = cleanArr;
                                }
                                // Also seed latestSyncData so ?! lists are saved even if unchanged
                                if (isSyncDataTarget(l.name)) {
                                    latestSyncData.lists[l.name] = cleanArr;
                                }
                                console.log(`[EntrySync Inject] Initial List Applied: ${l.name} [${arr.length} items]`);
                            }
                        }
                    }
                });
            }

            // 1. Data Only (??)
            if (payload.dataOnly) {
                applyVarsCollection(payload.dataOnly.variables);
                applyListsCollection(payload.dataOnly.lists);
            }

            // 2. Sync Only (!!)
            if (payload.syncOnly) {
                applyVarsCollection(payload.syncOnly.variables);
                applyListsCollection(payload.syncOnly.lists);
            }

            // 3. Sync Data (?!)
            if (payload.syncData) {
                applyVarsCollection(payload.syncData.variables);
                applyListsCollection(payload.syncData.lists);
            }

            // 4. Flat payload fallback
            if (payload.variables) applyVarsCollection(payload.variables);
            if (payload.lists) applyListsCollection(payload.lists);

            if (typeof vc.updateViews === 'function') vc.updateViews();
        } catch (e) {
            console.error('[EntrySync Inject] Error applying initial payload:', e);
        } finally {
            isApplyingRemote = false;
            isStartingUp = false;
        }
    }

    // ===== 5. Capture Snapshot for Data Only (??) on Stop =====
    function captureDataOnlySnapshot() {
        // PRIORITY: latestDataOnly (real-time tracked buffer) takes precedence over live Entry variables.
        // Reason: Entry resets variables to default values when engine stops. By the time
        // event-listener-based stop hooks fire, variables may already be reset.
        // latestDataOnly always holds the last "during game" value.
        const snapshot = { variables: {}, lists: {} };
        try {
            // Step 1: Populate from real-time tracked buffer (highest priority)
            Object.entries(latestDataOnly.variables).forEach(([name, val]) => {
                snapshot.variables[name] = val;
            });
            Object.entries(latestDataOnly.lists).forEach(([name, arr]) => {
                snapshot.lists[name] = arr;
            });

            // Step 2: Fill in ONLY variables/lists NOT already captured from latestDataOnly.
            // This handles the case where a ?? variable was never changed during the game
            // AND was not set via applyInitialData (e.g., not present in Firebase).
            if (window.Entry && window.Entry.variableContainer) {
                const vc = window.Entry.variableContainer;

                if (vc.variables_) {
                    const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
                    vars.forEach(v => {
                        const name = v.name_ || v.name;
                        if (isDataOnlyTarget(name) && !(name in snapshot.variables)) {
                            // Only use live value if latestDataOnly doesn't have this variable
                            const val = v.getValue ? v.getValue() : (v.value_ !== undefined ? v.value_ : v.value);
                            if (val !== undefined && val !== null) {
                                snapshot.variables[name] = val;
                            }
                        }
                    });
                }

                if (vc.lists_) {
                    const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
                    lists.forEach(l => {
                        const name = l.name_ || l.name;
                        if (isDataOnlyTarget(name) && !(name in snapshot.lists)) {
                            // Only use live value if latestDataOnly doesn't have this list
                            const rawArr = l.array_ || l.array || (l.getArray ? l.getArray() : []);
                            const arr = Array.isArray(rawArr)
                                ? rawArr.map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                : [];
                            if (arr.length > 0) {
                                snapshot.lists[name] = arr;
                            }
                        }
                    });
                }
            }
            console.log(`[EntrySync Inject] 📸 ?? Data Only Snapshot captured:`, snapshot);
        } catch (e) {
            console.error('[EntrySync Inject] Error capturing data snapshot:', e);
        }
        return snapshot;
    }

    // ===== 6. Inspect Entry Variables for Popup Recognition =====
    function inspectProjectVariables() {
        const result = {
            hasSyncVars: false,
            vars: {},
            lists: []
        };
        try {
            if (window.Entry && window.Entry.variableContainer) {
                const vc = window.Entry.variableContainer;
                if (vc.variables_) {
                    const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
                    vars.forEach(v => {
                        const name = v.name_ || v.name;
                        if (name) {
                            result.vars[name] = v.getValue ? v.getValue() : v.value;
                            if (isAnyManagedTarget(name)) {
                                result.hasSyncVars = true;
                            }
                        }
                    });
                }
                if (vc.lists_) {
                    const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
                    lists.forEach(l => {
                        const name = l.name_ || l.name;
                        if (name) {
                            result.lists.push({ name: name });
                            if (isAnyManagedTarget(name)) {
                                result.hasSyncVars = true;
                            }
                        }
                    });
                }
            }
        } catch (e) {}
        return result;
    }

    // ===== 7. Hook Entry Engine Run & Stop Events =====
    function hookEntryEngine() {
        if (!window.Entry || !window.Entry.engine) return;

        function onGameRun() {
            console.log('[EntrySync Inject] 🚀 Entry Engine RUN Event Detected!');
            isGameStopping = false;
            isStartingUp = true;
            stopEventSent = false;    // Reset stop dedup flag for this game cycle
            statusVarHooked = false;  // Reset so hook reinstalls for this new game session

            // Reset buffers so we don't re-save stale data from previous game cycle
            latestDataOnly = { variables: {}, lists: {} };
            latestSyncData = { variables: {}, lists: {} };

            setupSyncHooks();
            hookStatusVariable(); // Install status var protection hook

            // Update status variable with multi-stage timing to survive Entry's reset sequence
            updateStatusVariable(isConnectedToCloudflare);
            setTimeout(() => { hookStatusVariable(); updateStatusVariable(isConnectedToCloudflare); }, 50);
            setTimeout(() => { hookStatusVariable(); updateStatusVariable(isConnectedToCloudflare); }, 150);
            setTimeout(() => { hookStatusVariable(); updateStatusVariable(isConnectedToCloudflare); }, 400);
            setTimeout(() => { hookStatusVariable(); updateStatusVariable(isConnectedToCloudflare); }, 800);
            setTimeout(() => updateStatusVariable(isConnectedToCloudflare), 1200);

            // Notify content.js to connect WebSocket and request initial data
            window.postMessage({ type: 'ENTRY_SYNC_ENGINE_RUN' }, '*');

            if (pendingPayload) {
                applyInitialData(pendingPayload);
            }

            setTimeout(() => {
                isStartingUp = false;
            }, 500);
        }

        function onGameStop() {
            // DEDUP: Entry fires multiple stop hooks (addEventListener, engine.on, monkey-patch).
            // Only the FIRST onGameStop call should capture and send the snapshot.
            // Later calls happen after Entry has already reset variables to default values.
            if (stopEventSent) {
                console.log('[EntrySync Inject] ⏹️ Duplicate stop event ignored.');
                return;
            }
            stopEventSent = true;
            isGameStopping = true;
            console.log('[EntrySync Inject] ⏹️ Entry Engine STOP Event Detected!');

            // Capture ?? variables/lists snapshot BEFORE Entry resets them
            const dataOnlySnapshot = captureDataOnlySnapshot();
            // Include ?! snapshot so server saves ?! even if vars were never changed this session
            const syncDataSnapshot = {
                variables: Object.assign({}, latestSyncData.variables),
                lists: Object.assign({}, latestSyncData.lists)
            };

            window.postMessage({
                type: 'ENTRY_SYNC_ENGINE_STOP',
                dataOnlySnapshot: dataOnlySnapshot,
                syncDataSnapshot: syncDataSnapshot
            }, '*');
        }

        if (!isHooked) {
            const engine = window.Entry.engine;

            // 1. Entry.addEventListener
            if (window.Entry && typeof window.Entry.addEventListener === 'function') {
                try {
                    window.Entry.addEventListener('run', onGameRun);
                    window.Entry.addEventListener('stop', onGameStop);
                    console.log('[EntrySync Inject] Hooked via window.Entry.addEventListener');
                } catch (e) {}
            }

            // 2. engine.on
            if (typeof engine.on === 'function') {
                try {
                    engine.on('run', onGameRun);
                    engine.on('stop', onGameStop);
                    console.log('[EntrySync Inject] Hooked via engine.on()');
                } catch (e) {}
            }

            // 3. Monkey patch engine.run / engine.stop
            const originalRun = engine.run;
            const originalStop = engine.stop;

            if (originalRun) {
                engine.run = function () {
                    const res = originalRun.apply(this, arguments);
                    onGameRun();
                    return res;
                };
            }

            if (originalStop) {
                engine.stop = function () {
                    onGameStop();
                    return originalStop.apply(this, arguments);
                };
            }

            isHooked = true;
            console.log('[EntrySync Inject] Successfully established 3-way engine hook.');

            if (engine.isState && engine.isState('run')) {
                onGameRun();
            }
        }
    }

    // ===== 8. Window PostMessage Listener (Bridge with content.js) =====
    window.addEventListener('message', function (event) {
        if (!event.data) return;

        // Connection status changed
        if (event.data.type === 'ENTRY_SYNC_STATUS_UPDATE') {
            updateStatusVariable(event.data.connected);
            if (event.data.connected) {
                setupSyncHooks();
            }
        }

        // Apply initial data bundle from Cloudflare DO
        if (event.data.type === 'ENTRY_SYNC_APPLY_INITIAL_DATA') {
            console.log('[EntrySync Inject] Applying initial room data bundle:', event.data.payload);
            updateStatusVariable(event.data.connected);
            setupSyncHooks();
            if (event.data.payload) {
                applyInitialData(event.data.payload);
            }
        }

        // Realtime Remote Variable Update (!! or ?!)
        if (event.data.type === 'ENTRY_SYNC_REMOTE_VAR_UPDATE') {
            applyRemoteVar(event.data.name, event.data.value);
        }

        // Realtime Remote List Update (!! or ?!)
        if (event.data.type === 'ENTRY_SYNC_REMOTE_LIST_UPDATE') {
            applyRemoteList(event.data.name, event.data.array);
        }

        // Query variable recognition status for Popup
        if (event.data.type === 'REQ_ENTRY_VARS_INSPECTION') {
            const inspection = inspectProjectVariables();
            window.postMessage({
                type: 'RESP_ENTRY_VARS_INSPECTION',
                inspection: inspection
            }, '*');
        }
    });

    // Page Unload / Refresh / Close Handlers
    function handlePageUnload() {
        if (window.Entry && window.Entry.engine && window.Entry.engine.isState && window.Entry.engine.isState('run')) {
            const dataOnlySnapshot = captureDataOnlySnapshot();
            window.postMessage({
                type: 'ENTRY_SYNC_PAGE_UNLOAD',
                dataOnlySnapshot: dataOnlySnapshot
            }, '*');
        }
    }

    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);

    // Polling backup for dynamic iframe injection & engine detection
    let lastKnownRunState = false;
    const checkInterval = setInterval(function () {
        if (window.Entry && window.Entry.engine && window.Entry.variableContainer) {
            setupSyncHooks();
            hookEntryEngine();

            if (pendingPayload && window.Entry.variableContainer.variables_) {
                applyInitialData(pendingPayload);
            }

            const isRunning = window.Entry.engine.isState && window.Entry.engine.isState('run');
            if (isRunning && !lastKnownRunState) {
                lastKnownRunState = true;
                console.log('[EntrySync Inject] 🚀 Engine state "run" detected by polling!');
                updateStatusVariable(isConnectedToCloudflare);
                window.postMessage({ type: 'ENTRY_SYNC_ENGINE_RUN' }, '*');
            } else if (!isRunning && lastKnownRunState) {
                lastKnownRunState = false;
                console.log('[EntrySync Inject] ⏹️ Engine state "stop" detected by polling!');
                // Only send if not already sent by the monkey-patch hook (which fires before Entry resets variables)
                if (!stopEventSent) {
                    stopEventSent = true;
                    const dataOnlySnapshot = captureDataOnlySnapshot();
                    window.postMessage({
                        type: 'ENTRY_SYNC_ENGINE_STOP',
                        dataOnlySnapshot: dataOnlySnapshot
                    }, '*');
                }
            }
        }
    }, 200);

})();
