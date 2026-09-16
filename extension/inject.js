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
    let isInitialDataLoaded = false; // Flag to prevent saving default workspace values before Firebase initial data is applied
    let statusVarHooked = false;  // Flag to ensure status var hook is installed once
    let stopEventSent = false;    // Flag to prevent duplicate stop events (multi-hook dedup)

    let hookedVariables = new Set();
    let hookedLists = new Set();
    let pendingPayload = null;
    let isHooked = false;
    let latestDataOnly = { variables: {}, lists: {} }; // Tracks ?? variable state
    let latestSyncData = { variables: {}, lists: {} }; // Tracks ?! variable state
    let frozenSyncData = null; // Snapshot of latestSyncData frozen on 'beforeStop' (BEFORE Entry's loadSnapshot corrupts it)

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
    // Requirement: 작품 시작 누르자마자 변경 및 서버 연결 상태 숫자와 ?! 자체인 변수의 값이 다를 때마다 지속적으로 업데이트
    function updateStatusVariable(connected) {
        isConnectedToCloudflare = connected;
        try {
            if (window.Entry && window.Entry.variableContainer && window.Entry.variableContainer.variables_) {
                const vc = window.Entry.variableContainer;
                const vars = Array.isArray(vc.variables_)
                    ? vc.variables_
                    : Object.values(vc.variables_);

                const expectedStatusVal = connected ? 1 : -1;

                vars.forEach(v => {
                    const name = v.name_ || v.name;
                    if (isStatusVar(name)) {
                        const currentVal = v.getValue ? v.getValue() : (v.value_ !== undefined ? v.value_ : v.value);
                        // 서버 연결 상태 숫자와 ?! 자체인 변수의 값이 다를 때마다 즉시 업데이트!
                        if (currentVal !== expectedStatusVal) {
                            const prevApplying = isApplyingRemote;
                            isApplyingRemote = true;
                            if (typeof v.setValue === 'function') {
                                v.setValue(expectedStatusVal);
                            }
                            v.value_ = expectedStatusVal;
                            v.value = expectedStatusVal;
                            if (typeof v.setOriginValue === 'function') {
                                v.setOriginValue(expectedStatusVal);
                            }
                            if (v.snapshot_) {
                                v.snapshot_.value = expectedStatusVal;
                            }
                            isApplyingRemote = prevApplying;
                            if (typeof v.updateView === 'function') v.updateView();
                            console.log(`[EntrySync Inject] ⚡ Status Variable '${name}' auto-synced: ${currentVal} -> ${expectedStatusVal} (connected: ${connected})`);
                        }
                    }
                });
            }
        } catch (e) {
            console.error('[EntrySync Inject] Error updating status variable:', e);
        }
    }

    let workspaceSaveDebounceTimer = null;
    function triggerWorkspaceSave() {
        if (!isInitialDataLoaded) {
            console.log('[EntrySync Inject] ⏳ Skipping triggerWorkspaceSave (initial data not loaded yet)');
            return;
        }
        if (workspaceSaveDebounceTimer) clearTimeout(workspaceSaveDebounceTimer);
        workspaceSaveDebounceTimer = setTimeout(() => {
            const dataOnlySnapshot = captureDataOnlySnapshot();
            const syncDataSnapshot = captureSyncDataSnapshot();
            console.log('[EntrySync Inject] 💾 triggerWorkspaceSave dispatched:', { dataOnly: dataOnlySnapshot, syncData: syncDataSnapshot });
            window.postMessage({
                type: 'ENTRY_SYNC_SAVE_DATA_NOW',
                dataOnlySnapshot: dataOnlySnapshot,
                syncDataSnapshot: syncDataSnapshot
            }, '*');
        }, 200);
    }

    // ===== 1b. Hook Entry.do (Commander) to catch ALL workspace variable/list edits =====
    let commanderHooked = false;
    function hookEntryCommander() {
        if (commanderHooked || !window.Entry || typeof window.Entry.do !== 'function') return;
        const originalEntryDo = window.Entry.do;
        window.Entry.do = function (commandType, ...args) {
            const ret = originalEntryDo.apply(this, arguments);
            try {
                const cmdStr = String(commandType);
                if (cmdStr.includes('variable') || cmdStr.includes('list') || cmdStr.includes('Variable') || cmdStr.includes('List')) {
                    const isEngineRunning = window.Entry &&
                        window.Entry.engine &&
                        window.Entry.engine.isState &&
                        window.Entry.engine.isState('run');
                    if (!isEngineRunning && !isApplyingRemote && isInitialDataLoaded) {
                        console.log(`[EntrySync Inject] 🎯 Entry.do('${cmdStr}') detected in workspace! Triggering save...`);
                        triggerWorkspaceSave();
                    }
                }
            } catch (e) {}
            return ret;
        };
        commanderHooked = true;
        console.log('[EntrySync Inject] 🎯 Successfully hooked Entry.do for workspace commands.');
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

                    // Disable Entry's built-in cloud/realtime mode which intercepts getValue/setValue
                    v.isRealTime_ = false;
                    v.isCloud_ = false;
                    v.getValue = function () {
                        return this.value_ !== undefined ? this.value_ : this.value;
                    };

                    function handleVarChange(val) {
                        if (isGameStopping || isApplyingRemote || isStartingUp) return;
                        const isEngineRunning = window.Entry &&
                            window.Entry.engine &&
                            window.Entry.engine.isState &&
                            window.Entry.engine.isState('run');

                        // Track ?? in real-time memory buffer
                        if (isDataOnlyTarget(name)) {
                            latestDataOnly.variables[name] = val;
                            if (!isEngineRunning) triggerWorkspaceSave();
                        }
                        // Track ?! in real-time memory buffer (for save-on-stop and workspace edits)
                        if (isSyncDataTarget(name)) {
                            if (!isGameStopping) {
                                latestSyncData.variables[name] = val;
                            }
                            if (!isEngineRunning) {
                                triggerWorkspaceSave();
                            }
                        }

                        // Broadcast !! and ?! in real-time to peers
                        if (isRealtimeTarget(name)) {
                            window.postMessage({
                                type: 'ENTRY_SYNC_VAR_CHANGED',
                                name: name,
                                value: val
                            }, '*');
                        }
                    }

                    // Protect syncModel_ and loadSnapshot against missing name/id asserts
                    const origVarSyncModel = v.syncModel_;
                    if (typeof origVarSyncModel === 'function') {
                        v.syncModel_ = function (variableModel) {
                            if (variableModel) {
                                if (!variableModel.name) variableModel.name = this.name_ || this.name || '';
                                if (!variableModel.id) variableModel.id = this.id_ || this.id || '';
                                if (!variableModel.variableType) variableModel.variableType = this.type || 'variable';
                            }
                            return origVarSyncModel.call(this, variableModel);
                        };
                    }
                    const origVarLoadSnapshot = v.loadSnapshot;
                    if (typeof origVarLoadSnapshot === 'function') {
                        v.loadSnapshot = function () {
                            try {
                                if (this.snapshot_) {
                                    if (!this.snapshot_.name) this.snapshot_.name = this.name_ || this.name || '';
                                    if (!this.snapshot_.id) this.snapshot_.id = this.id_ || this.id || '';
                                    if (!this.snapshot_.variableType) this.snapshot_.variableType = this.type || 'variable';
                                }
                                return origVarLoadSnapshot.apply(this, arguments);
                            } catch (e) {
                                console.warn('[EntrySync Inject] Protected against var loadSnapshot error:', e);
                            }
                        };
                    }

                    // 1. Hook setValue (runtime script value changes)
                    const originalSetValue = v.setValue;
                    if (typeof originalSetValue === 'function') {
                        v.setValue = function (val) {
                            const ret = originalSetValue.apply(this, arguments);
                            handleVarChange(val);
                            return ret;
                        };
                    }

                    // 2. Hook setOriginValue (workspace property tab edits)
                    if (typeof v.setOriginValue === 'function') {
                        const originalSetOriginValue = v.setOriginValue;
                        v.setOriginValue = function (val) {
                            const ret = originalSetOriginValue.apply(this, arguments);
                            handleVarChange(val);
                            return ret;
                        };
                    }

                    // 3. Property descriptor hook for originValue_ (workspace input blur/enter direct assignment)
                    try {
                        let internalOriginVal = v.originValue_;
                        Object.defineProperty(v, 'originValue_', {
                            get: function () { return internalOriginVal; },
                            set: function (newVal) {
                                internalOriginVal = newVal;
                                handleVarChange(newVal);
                            },
                            configurable: true,
                            enumerable: true
                        });
                    } catch (e) {}
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

                    // Disable Entry's built-in cloud/realtime mode which intercepts getArray/setArray
                    l.isRealTime_ = false;
                    l.isCloud_ = false;
                    l.getArray = function () {
                        return this.array_ || [];
                    };

                    // Protect syncModel_ and loadSnapshot against missing name/id asserts
                    const origListSyncModel = l.syncModel_;
                    if (typeof origListSyncModel === 'function') {
                        l.syncModel_ = function (variableModel) {
                            if (variableModel) {
                                if (!variableModel.name) variableModel.name = this.name_ || this.name || '';
                                if (!variableModel.id) variableModel.id = this.id_ || this.id || '';
                                if (!variableModel.variableType) variableModel.variableType = this.type || 'list';
                            }
                            return origListSyncModel.call(this, variableModel);
                        };
                    }
                    const origListLoadSnapshot = l.loadSnapshot;
                    if (typeof origListLoadSnapshot === 'function') {
                        l.loadSnapshot = function () {
                            try {
                                if (this.snapshot_) {
                                    if (!this.snapshot_.name) this.snapshot_.name = this.name_ || this.name || '';
                                    if (!this.snapshot_.id) this.snapshot_.id = this.id_ || this.id || '';
                                    if (!this.snapshot_.variableType) this.snapshot_.variableType = this.type || 'list';
                                }
                                return origListLoadSnapshot.apply(this, arguments);
                            } catch (e) {
                                console.warn('[EntrySync Inject] Protected against list loadSnapshot error:', e);
                            }
                        };
                    }

                    function notifyListChange(isFromUpdateView = false) {
                        if (isGameStopping || isApplyingRemote || isStartingUp) return;
                        const isEngineRunning = window.Entry &&
                            window.Entry.engine &&
                            window.Entry.engine.isState &&
                            window.Entry.engine.isState('run');

                        // updateView hook is strictly for workspace UI typing when game is NOT running!
                        if (isFromUpdateView && isEngineRunning) return;

                        const rawArr = l.getArray ? l.getArray() : (l.array_ || l.originArray_ || l.array || []);
                        const arr = Array.isArray(rawArr)
                            ? rawArr.map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                            : [];

                        // Track ?? in real-time memory buffer
                        if (isDataOnlyTarget(name)) {
                            latestDataOnly.lists[name] = arr;
                            if (!isEngineRunning) triggerWorkspaceSave();
                        }
                        // Track ?! in real-time memory buffer (for save-on-stop and workspace edits)
                        if (isSyncDataTarget(name)) {
                            if (!isGameStopping) {
                                latestSyncData.lists[name] = arr;
                            }
                            if (!isEngineRunning) {
                                triggerWorkspaceSave();
                            }
                        }

                        // Broadcast !! and ?! in real-time to peers ONLY during game run and NOT from pure updateView
                        if (isRealtimeTarget(name) && isEngineRunning && !isFromUpdateView) {
                            window.postMessage({
                                type: 'ENTRY_SYNC_LIST_CHANGED',
                                name: name,
                                array: arr
                            }, '*');
                        }
                    }

                    const methodsToHook = ['appendValue', 'insertValue', 'deleteValue', 'replaceValue', 'setArray', 'setList', 'setOriginArray'];
                    methodsToHook.forEach(methodName => {
                        if (typeof l[methodName] === 'function') {
                            const originalMethod = l[methodName];
                            l[methodName] = function () {
                                const ret = originalMethod.apply(this, arguments);
                                notifyListChange(false);
                                return ret;
                            };
                        }
                    });

                    // Hook updateView specifically for workspace property panel typing (when game is NOT running)
                    if (typeof l.updateView === 'function') {
                        const originalUpdateView = l.updateView;
                        l.updateView = function () {
                            const ret = originalUpdateView.apply(this, arguments);
                            notifyListChange(true);
                            return ret;
                        };
                    }

                    // Property descriptor hook for originArray_ (workspace property tab direct assignment)
                    try {
                        let internalOriginArr = l.originArray_;
                        Object.defineProperty(l, 'originArray_', {
                            get: function () { return internalOriginArr; },
                            set: function (newVal) {
                                internalOriginArr = newVal;
                                // Only trigger save if NOT currently applying remote data
                                if (!isApplyingRemote && !isStartingUp) {
                                    if (!isGameStopping && Array.isArray(newVal)) {
                                        l.array_ = newVal;
                                    }
                                    notifyListChange();
                                }
                            },
                            configurable: true,
                            enumerable: true
                        });
                    } catch (e) {}
                }
            });
        }
        hookEntryCommander();
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
                target.value_ = value;
                if (typeof target.setOriginValue === 'function') {
                    target.setOriginValue(value);
                } else {
                    target.originValue_ = value;
                }
                if (typeof target.updateView === 'function') target.updateView();
                if (isSyncDataTarget(name)) {
                    latestSyncData.variables[name] = value;
                }
                console.log(`[EntrySync Inject] 📥 Remote Var Applied: ${name} =`, value);
            }
        } finally {
            isApplyingRemote = false;
        }
    }

    // Helper: Safely update or initialize target.snapshot_ conforming to Entry's VariableModel requirements
    function updateTargetSnapshot(target, newArr) {
        if (!target) return;
        try {
            const clonedArr = JSON.parse(JSON.stringify(newArr || []));
            if (target.snapshot_) {
                target.snapshot_.array = clonedArr;
                if (!target.snapshot_.name) target.snapshot_.name = target.name_ || target.name || '';
                if (!target.snapshot_.id) target.snapshot_.id = target.id_ || target.id || '';
                if (!target.snapshot_.variableType) target.snapshot_.variableType = target.type || 'list';
            } else if (typeof target.toJSON === 'function') {
                const snap = target.toJSON();
                snap.array = clonedArr;
                target.snapshot_ = snap;
            } else {
                target.snapshot_ = {
                    id: target.id_ || target.id || '',
                    name: target.name_ || target.name || '',
                    variableType: target.type || 'list',
                    array: clonedArr,
                    x: target.getX ? target.getX() : (target.x_ || 0),
                    y: target.getY ? target.getY() : (target.y_ || 0),
                    visible: target.isVisible ? target.isVisible() : (target.visible_ !== undefined ? target.visible_ : true),
                    width: target.getWidth ? target.getWidth() : (target.width_ || 100),
                    height: target.getHeight ? target.getHeight() : (target.height_ || 120)
                };
            }
        } catch (e) {
            console.error('[EntrySync Inject] Error updating target.snapshot_:', e);
        }
    }

    // Helper: Force clean and re-render Entry Stage List Canvas Widget
    function forceRenderListWidget(target) {
        if (!target) return;
        try {
            target.scrollPosition = 0;
            if (target.scrollButton_) {
                target.scrollButton_.y = 25;
            }
            if (target.view_ && Array.isArray(target.view_.children)) {
                // Remove existing rendered list elements (from index 4 upwards)
                while (target.view_.children.length > 4) {
                    const child = target.view_.children[4];
                    target.view_.removeChild(child);
                    if (child && typeof child.destroy === 'function') {
                        try { child.destroy(); } catch (e) {}
                    }
                }
            }
            if (typeof target.updateView === 'function') {
                target.updateView();
            }
            if (window.Entry) {
                Entry.requestUpdate = true;
                Entry.requestUpdateTwice = true;
                if (Entry.stage && typeof Entry.stage.update === 'function') {
                    try { Entry.stage.update(); } catch (e) {}
                }
            }
        } catch (e) {
            console.error('[EntrySync Inject] Error in forceRenderListWidget:', e);
        }
    }

    function ensureListRendered(target) {
        forceRenderListWidget(target);
        requestAnimationFrame(() => forceRenderListWidget(target));
        setTimeout(() => forceRenderListWidget(target), 50);
        setTimeout(() => forceRenderListWidget(target), 200);
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
                // Directly assign to internal properties to bypass hooked methods
                // (hooked setArray/setOriginArray would call notifyListChange and echo to server)
                target.isRealTime_ = false;
                target.isCloud_ = false;
                target.getArray = function () { return this.array_ || []; };
                target.array_ = arr;
                target.array = arr;
                target.originArray_ = JSON.parse(JSON.stringify(arr));
                updateTargetSnapshot(target, arr);
                if (isSyncDataTarget(name)) {
                    latestSyncData.lists[name] = rawArr;
                }
                ensureListRendered(target);
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
            // Top window on project play page does not have Entry (Entry runs inside the game iframe)
            if (!window.Entry && window === window.top && !window.location.href.includes('/ws/')) {
                return;
            }
            // Retry up to 30 times (6 seconds) - workspace page loads Entry slowly
            if (retryCount < 30) {
                pendingPayload = payload;
                setTimeout(() => applyInitialData(payload, retryCount + 1), 200);
            } else {
                isStartingUp = false;
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
                if (items.length === 0) return;

                items.forEach(v => {
                    if (v.name && !isStatusVar(v.name) && v.value !== undefined && v.value !== null) {
                        const matchingVars = allVars.filter(item => (item.getName ? item.getName() : (item.name_ || item.name)) === v.name);
                        matchingVars.forEach(target => {
                            target.isRealTime_ = false;
                            target.isCloud_ = false;
                            target.getValue = function () {
                                return this.value_ !== undefined ? this.value_ : this.value;
                            };
                            if (typeof target.setValue === 'function') target.setValue(v.value);
                            else target.value = v.value;
                            target.value_ = v.value;

                            // Sync snapshot_ so Entry engine reset does not revert Firebase value
                            if (target.snapshot_) {
                                target.snapshot_.value = v.value;
                            }

                            if (typeof target.setOriginValue === 'function') {
                                target.setOriginValue(v.value);
                            } else {
                                target.originValue_ = v.value;
                            }

                            if (typeof target.updateView === 'function') target.updateView();
                            if (vc.updateVariableSettingView && vc.selected === target) {
                                try { vc.updateVariableSettingView(target); } catch (e) {}
                            }

                            if (isDataOnlyTarget(v.name)) {
                                latestDataOnly.variables[v.name] = v.value;
                            }
                            if (isSyncDataTarget(v.name)) {
                                latestSyncData.variables[v.name] = v.value;
                            }
                            console.log(`[EntrySync Inject] Initial Var Applied: ${v.name} =`, v.value);
                        });
                    }
                });
            }

            // Helper to apply list map/array
            function applyListsCollection(listsData) {
                if (!listsData) return;
                const items = Array.isArray(listsData)
                    ? listsData
                    : Object.entries(listsData).map(([name, array]) => ({ name, array }));
                if (items.length === 0) return;

                items.forEach(l => {
                    if (l.name) {
                        const matchingLists = allLists.filter(item => (item.getName ? item.getName() : (item.name_ || item.name)) === l.name);
                        matchingLists.forEach(target => {
                            const rawArr = Array.isArray(l.array) ? l.array : (Array.isArray(l) ? l : []);
                            const cleanArr = rawArr
                                .map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                .filter(item => item !== null && item !== undefined);
                            const arr = cleanArr.map(item => ({ data: item }));

                            // Disable Entry's built-in cloudVariable override
                            target.isRealTime_ = false;
                            target.isCloud_ = false;
                            target.getArray = function () {
                                return this.array_ || [];
                            };

                            // Directly assign to internal properties
                            target.array_ = arr;
                            target.array = arr;

                            // Sync snapshot_ so Entry engine reset does not revert Firebase elements
                            updateTargetSnapshot(target, arr);

                            // Directly assign originArray_ to bypass hooked setter
                            target.originArray_ = JSON.parse(JSON.stringify(arr));

                            ensureListRendered(target);

                            if (isDataOnlyTarget(l.name)) {
                                latestDataOnly.lists[l.name] = cleanArr;
                            }
                            if (isSyncDataTarget(l.name)) {
                                latestSyncData.lists[l.name] = cleanArr;
                            }
                            console.log(`[EntrySync Inject] Initial List Applied: ${l.name} [${arr.length} items] (live length: ${target.array_.length})`);
                        });
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

            // Refresh Entry Property Panel DOM once for all lists and variables
            try {
                if (vc.selected) {
                    if (typeof vc.updateSelected === 'function') {
                        vc.updateSelected();
                    } else if (typeof vc.select === 'function') {
                        const sel = vc.selected;
                        vc.selected = null;
                        vc.select(sel);
                    }
                }
                if (typeof vc.updateList === 'function') vc.updateList();
                if (typeof vc.updateListTab === 'function') vc.updateListTab();
            } catch (e) {}
        } catch (e) {
            console.error('[EntrySync Inject] Error applying initial payload:', e);
        } finally {
            isApplyingRemote = false;
            isStartingUp = false;
            setTimeout(() => {
                isInitialDataLoaded = true;
                console.log('[EntrySync Inject] ✅ isInitialDataLoaded = true. Workspace saves now enabled.');
            }, 300);
        }
    }

    // ===== 5. Capture Snapshot for Data Only (??) on Stop / Edit =====
    function captureDataOnlySnapshot() {
        const snapshot = { variables: {}, lists: {} };
        try {
            // Step 1: Base values from Entry's live objects (if available)
            if (window.Entry && window.Entry.variableContainer) {
                const vc = window.Entry.variableContainer;

                if (vc.variables_) {
                    const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
                    vars.forEach(v => {
                        const name = v.name_ || v.name;
                        if (isDataOnlyTarget(name)) {
                            const val = v.getValue ? v.getValue() : (v.value_ !== undefined ? v.value_ : (v.originValue_ !== undefined ? v.originValue_ : v.value));
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
                        if (isDataOnlyTarget(name)) {
                            const rawArr = l.getArray ? l.getArray() : (l.array_ || l.originArray_ || l.array || []);
                            const arr = Array.isArray(rawArr)
                                ? rawArr.map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                : [];
                            snapshot.lists[name] = arr;
                        }
                    });
                }
            }

            // Step 2: In-memory buffers ALWAYS have highest priority because they are untouched by Entry's internal resets
            Object.entries(latestDataOnly.variables).forEach(([name, val]) => {
                if (val !== undefined && val !== null) {
                    snapshot.variables[name] = val;
                }
            });
            Object.entries(latestDataOnly.lists).forEach(([name, arr]) => {
                if (Array.isArray(arr)) {
                    snapshot.lists[name] = arr;
                }
            });

            console.log(`[EntrySync Inject] 📸 ?? Data Only Snapshot captured:`, snapshot);
        } catch (e) {
            console.error('[EntrySync Inject] Error capturing data snapshot:', e);
        }
        return snapshot;
    }

    function captureSyncDataSnapshot() {
        const snapshot = { variables: {}, lists: {} };
        try {
            // Step 1: Base values from Entry's live objects (if available)
            if (window.Entry && window.Entry.variableContainer) {
                const vc = window.Entry.variableContainer;

                if (vc.variables_) {
                    const vars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
                    vars.forEach(v => {
                        const name = v.name_ || v.name;
                        if (isSyncDataTarget(name)) {
                            const val = v.getValue ? v.getValue() : (v.value_ !== undefined ? v.value_ : (v.originValue_ !== undefined ? v.originValue_ : v.value));
                            if (val !== undefined && val !== null) {
                                snapshot.variables[name] = val;
                                if (!frozenSyncData && !isGameStopping) {
                                    latestSyncData.variables[name] = val;
                                }
                            }
                        }
                    });
                }

                if (vc.lists_) {
                    const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
                    lists.forEach(l => {
                        const name = l.name_ || l.name;
                        if (isSyncDataTarget(name)) {
                            const rawArr = l.getArray ? l.getArray() : (l.array_ || l.originArray_ || l.array || []);
                            const arr = Array.isArray(rawArr)
                                ? rawArr.map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                : [];
                            snapshot.lists[name] = arr;
                            if (!frozenSyncData && !isGameStopping) {
                                latestSyncData.lists[name] = arr;
                            }
                        }
                    });
                }
            }

            // Step 2: In-memory buffers override live Entry values
            // frozenSyncData (captured on 'beforeStop' BEFORE loadSnapshot runs) has HIGHEST priority.
            // latestSyncData is used as fallback if frozenSyncData is not available.
            const syncBuffer = frozenSyncData || latestSyncData;
            Object.entries(syncBuffer.variables).forEach(([name, val]) => {
                if (val !== undefined && val !== null) {
                    snapshot.variables[name] = val;
                }
            });
            Object.entries(syncBuffer.lists).forEach(([name, arr]) => {
                if (Array.isArray(arr)) {
                    snapshot.lists[name] = arr;
                }
            });
            if (frozenSyncData) {
                console.log('[EntrySync Inject] ❄️ captureSyncDataSnapshot: using frozenSyncData (protected from loadSnapshot corruption)');
            }
        } catch (e) {
            console.error('[EntrySync Inject] Error in captureSyncDataSnapshot:', e);
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
    let gameRunSetupDone = false; // Per-cycle dedup: prevents double-setup from multiple event listeners

    function hookEntryEngine() {
        if (!window.Entry || !window.Entry.engine) return;

        function onGameRun() {
            // DEDUP: Monkey-patch fires this BEFORE originalRun.
            // addEventListener/engine.on also fire it AFTER. Skip duplicates.
            if (gameRunSetupDone) {
                console.log('[EntrySync Inject] 🔄 onGameRun dedup skip (already set up this cycle).');
                return;
            }
            gameRunSetupDone = true;
            console.log('[EntrySync Inject] 🚀 Entry Engine RUN Event Detected!');
            isGameStopping = false;
            isStartingUp = true;      // Blocks local changes from broadcasting until Firebase data is applied
            stopEventSent = false;
            statusVarHooked = false;
            frozenSyncData = null;    // Clear frozen snapshot from previous stop

            setupSyncHooks();

            // Set status variable immediately if 0
            updateStatusVariable(isConnectedToCloudflare);
            setTimeout(() => updateStatusVariable(isConnectedToCloudflare), 80);
            setTimeout(() => updateStatusVariable(isConnectedToCloudflare), 250);

            // Notify content.js to connect WebSocket or request latest data
            window.postMessage({ type: 'ENTRY_SYNC_ENGINE_RUN' }, '*');

            if (!pendingPayload) {
                // No cached Firebase data yet — isStartingUp cleared when ENTRY_SYNC_APPLY_INITIAL_DATA arrives.
                // Safety fallback: clear after 4s in case server never responds.
                setTimeout(() => { isStartingUp = false; }, 4000);
            }
            // NOTE: If pendingPayload exists, it is applied in the monkey-patch BEFORE originalRun.
            // applyInitialData's finally block clears isStartingUp.
        }

        function onGameStop() {
            // DEDUP: Entry fires multiple stop hooks. Only the FIRST call should capture snapshot.
            if (stopEventSent) {
                console.log('[EntrySync Inject] ⏹️ Duplicate stop event ignored.');
                return;
            }
            stopEventSent = true;
            gameRunSetupDone = false; // Allow next game cycle to run setup again
            isGameStopping = true;
            console.log('[EntrySync Inject] ⏹️ Entry Engine STOP Event Detected!');

            // Capture snapshots BEFORE Entry resets them
            // Note: frozenSyncData (captured on 'beforeStop') takes priority in captureSyncDataSnapshot
            const dataOnlySnapshot = captureDataOnlySnapshot();
            const syncDataSnapshot = captureSyncDataSnapshot();

            window.postMessage({
                type: 'ENTRY_SYNC_ENGINE_STOP',
                dataOnlySnapshot: dataOnlySnapshot,
                syncDataSnapshot: syncDataSnapshot
            }, '*');

            // Clear frozenSyncData after a delay — post-stop workspace edits should use live Entry values
            setTimeout(function () { frozenSyncData = null; }, 800);
        }

        if (!isHooked) {
            const engine = window.Entry.engine;

            // 1. Entry.addEventListener (fires AFTER engine.run)
            if (window.Entry && typeof window.Entry.addEventListener === 'function') {
                try {
                    window.Entry.addEventListener('run', onGameRun);
                    window.Entry.addEventListener('stop', onGameStop);
                    // 'beforeStop' fires BEFORE Entry's loadSnapshot() — freeze latestSyncData here!
                    // This is critical: loadSnapshot() triggers originArray_ setter → notifyListChange()
                    // which would overwrite latestSyncData with stale snapshot values (10 items),
                    // corrupting the capture BEFORE onGameStop() fires.
                    window.Entry.addEventListener('beforeStop', function () {
                        if (!frozenSyncData && !stopEventSent) {
                            frozenSyncData = JSON.parse(JSON.stringify(latestSyncData));
                            console.log('[EntrySync Inject] ❄️ latestSyncData frozen on beforeStop (before loadSnapshot):', frozenSyncData);
                        }
                    });
                    console.log('[EntrySync Inject] Hooked via window.Entry.addEventListener');
                } catch (e) {}
            }

            // 2. engine.on (fires AFTER engine.run)
            if (typeof engine.on === 'function') {
                try {
                    engine.on('run', onGameRun);
                    engine.on('stop', onGameStop);
                    console.log('[EntrySync Inject] Hooked via engine.on()');
                } catch (e) {}
            }

            // 3. Monkey patch engine.run / engine.stop
            // CRITICAL: onGameRun is called BEFORE originalRun so that:
            //   a) Status variable hook is installed before Entry's loadSnapshot() fires
            //   b) Firebase snapshot data (pendingPayload) is applied before loadSnapshot() reads it
            const originalRun = engine.run;
            const originalStop = engine.stop;

            if (originalRun) {
                engine.run = function () {
                    gameRunSetupDone = false; // Reset dedup for this new cycle

                    // Apply cached Firebase data to snapshot_ BEFORE Entry's loadSnapshot()
                    // This ensures Entry restores Firebase values (not project defaults) on run
                    if (pendingPayload) {
                        const cachedPayload = pendingPayload;
                        pendingPayload = null;
                        isStartingUp = true;
                        isApplyingRemote = true;
                        try {
                            // Inline snapshot update — bypass full applyInitialData retry logic
                            // to ensure it runs synchronously before originalRun
                            const vc = window.Entry && window.Entry.variableContainer;
                            if (vc && vc.variables_) {
                                const allVars = Array.isArray(vc.variables_) ? vc.variables_ : Object.values(vc.variables_);
                                const allLists = vc.lists_ ? (Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_)) : [];

                                function preApplyVars(varsData) {
                                    if (!varsData) return;
                                    const items = Array.isArray(varsData)
                                        ? varsData
                                        : Object.entries(varsData).map(([name, value]) => ({ name, value }));
                                    items.forEach(v => {
                                        if (!v.name || isStatusVar(v.name) || v.value === undefined || v.value === null) return;
                                        const matchingVars = allVars.filter(item => (item.getName ? item.getName() : (item.name_ || item.name)) === v.name);
                                        matchingVars.forEach(target => {
                                            target.isRealTime_ = false;
                                            target.isCloud_ = false;
                                            target.getValue = function () {
                                                return this.value_ !== undefined ? this.value_ : this.value;
                                            };
                                            target.value_ = v.value;
                                            target.value = v.value;
                                            target.originValue_ = v.value;
                                            // Update snapshot_ so Entry's loadSnapshot() uses Firebase value
                                            if (target.snapshot_) target.snapshot_.value = v.value;
                                            if (isDataOnlyTarget(v.name)) latestDataOnly.variables[v.name] = v.value;
                                            if (isSyncDataTarget(v.name)) latestSyncData.variables[v.name] = v.value;
                                        });
                                    });
                                }

                                function preApplyLists(listsData) {
                                    if (!listsData) return;
                                    const items = Array.isArray(listsData)
                                        ? listsData
                                        : Object.entries(listsData).map(([name, array]) => ({ name, array }));
                                    items.forEach(l => {
                                        if (!l.name) return;
                                        const matchingLists = allLists.filter(item => (item.getName ? item.getName() : (item.name_ || item.name)) === l.name);
                                        matchingLists.forEach(target => {
                                            const rawArr = Array.isArray(l.array) ? l.array : [];
                                            const cleanArr = rawArr
                                                .map(item => (typeof item === 'object' && item !== null && 'data' in item) ? item.data : item)
                                                .filter(item => item !== null && item !== undefined);
                                            const arr = cleanArr.map(item => ({ data: item }));
                                            target.isRealTime_ = false;
                                            target.isCloud_ = false;
                                            target.getArray = function () {
                                                return this.array_ || [];
                                            };
                                            target.array_ = arr;
                                            target.array = arr;
                                            target.originArray_ = JSON.parse(JSON.stringify(arr));
                                            // Update snapshot_ so Entry's loadSnapshot() uses Firebase value
                                            updateTargetSnapshot(target, arr);
                                            ensureListRendered(target);
                                            if (isDataOnlyTarget(l.name)) latestDataOnly.lists[l.name] = cleanArr;
                                            if (isSyncDataTarget(l.name)) latestSyncData.lists[l.name] = cleanArr;
                                        });
                                    });
                                }

                                if (cachedPayload.dataOnly) { preApplyVars(cachedPayload.dataOnly.variables); preApplyLists(cachedPayload.dataOnly.lists); }
                                if (cachedPayload.syncOnly) { preApplyVars(cachedPayload.syncOnly.variables); preApplyLists(cachedPayload.syncOnly.lists); }
                                if (cachedPayload.syncData) { preApplyVars(cachedPayload.syncData.variables); preApplyLists(cachedPayload.syncData.lists); }
                                if (cachedPayload.variables) preApplyVars(cachedPayload.variables);
                                if (cachedPayload.lists) preApplyLists(cachedPayload.lists);
                                console.log('[EntrySync Inject] ⚡ Pre-run snapshot sync complete (Firebase data applied before loadSnapshot)');
                            } else {
                                // vc not ready, restore payload for post-run apply
                                pendingPayload = cachedPayload;
                            }
                        } catch (e) {
                            console.error('[EntrySync Inject] Pre-run snapshot sync error:', e);
                            pendingPayload = cachedPayload; // Restore on error
                        } finally {
                            isApplyingRemote = false;
                        }
                    }

                    // Flush any pending workspace edit before starting engine
                    if (workspaceSaveDebounceTimer) {
                        clearTimeout(workspaceSaveDebounceTimer);
                        workspaceSaveDebounceTimer = null;
                        const dataOnlySnapshot = captureDataOnlySnapshot();
                        const syncDataSnapshot = captureSyncDataSnapshot();
                        window.postMessage({
                            type: 'ENTRY_SYNC_SAVE_DATA_NOW',
                            dataOnlySnapshot: dataOnlySnapshot,
                            syncDataSnapshot: syncDataSnapshot
                        }, '*');
                    }

                    onGameRun(); // Setup hooks, status var, etc. — BEFORE Entry's loadSnapshot()
                    const ret = originalRun.apply(this, arguments); // Entry calls loadSnapshot()
                    updateStatusVariable(isConnectedToCloudflare); // Synchronously re-apply immediately (0ms delay!)
                    // Re-render all lists right after engine.run to overwrite any default engine list widgets
                    try {
                        const vc = window.Entry && window.Entry.variableContainer;
                        if (vc && vc.lists_) {
                            const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
                            lists.forEach(l => {
                                const name = l.name_ || l.name;
                                if (isSyncDataTarget(name) || isDataOnlyTarget(name)) {
                                    forceRenderListWidget(l);
                                }
                            });
                        }
                    } catch (e) {}
                    return ret;
                };
            }

            if (originalStop) {
                engine.stop = function () {
                    try {
                        onGameStop();
                    } catch (e) {
                        console.error('[EntrySync Inject] Error in onGameStop:', e);
                    }
                    let ret;
                    try {
                        ret = originalStop.apply(this, arguments);
                    } catch (e) {
                        console.error('[EntrySync Inject] Error in originalStop:', e);
                    }

                    // After stop, restore lists/variables from latestSyncData and latestDataOnly
                    // to prevent Entry from showing stale/default project items in the stopped state!
                    try {
                        const vc = window.Entry && window.Entry.variableContainer;
                        if (vc && vc.lists_) {
                            const lists = Array.isArray(vc.lists_) ? vc.lists_ : Object.values(vc.lists_);
                            lists.forEach(l => {
                                const name = l.name_ || l.name;
                                if (isSyncDataTarget(name) && latestSyncData.lists[name]) {
                                    const cleanArr = latestSyncData.lists[name];
                                    const arr = cleanArr.map(item => ({ data: item }));
                                    l.array_ = arr;
                                    l.array = arr;
                                    l.originArray_ = JSON.parse(JSON.stringify(arr));
                                    updateTargetSnapshot(l, arr);
                                    ensureListRendered(l);
                                } else if (isDataOnlyTarget(name) && latestDataOnly.lists[name]) {
                                    const cleanArr = latestDataOnly.lists[name];
                                    const arr = cleanArr.map(item => ({ data: item }));
                                    l.array_ = arr;
                                    l.array = arr;
                                    l.originArray_ = JSON.parse(JSON.stringify(arr));
                                    updateTargetSnapshot(l, arr);
                                    ensureListRendered(l);
                                }
                            });
                        }
                    } catch (e) {}

                    // Keep isGameStopping=true for 600ms to block Entry's async toggleStop from
                    // calling loadSnapshot → originArray_ setter → notifyListChange → triggerWorkspaceSave
                    // with stale snapshot data (the 73→10 issue). After 600ms, workspace edits work normally.
                    setTimeout(function () { isGameStopping = false; }, 600);
                    return ret;
                };
            }

            isHooked = true;
            console.log('[EntrySync Inject] Successfully established 3-way engine hook.');

            if (engine.isState && engine.isState('run')) {
                gameRunSetupDone = false;
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
        // Works on both play page (with engine) AND workspace page (without engine)
        const hasEntry = window.Entry && window.Entry.variableContainer;
        if (hasEntry) {
            setupSyncHooks();
            if (window.Entry.engine) {
                hookEntryEngine();
            } else {
                // Workspace page: no engine but variableContainer exists — apply pending payload directly
                hookEntryCommander();
            }

            if (pendingPayload && window.Entry.variableContainer.variables_) {
                const toApply = pendingPayload;
                pendingPayload = null;
                applyInitialData(toApply);
            }

            if (window.Entry.engine) {
                const isRunning = window.Entry.engine.isState && window.Entry.engine.isState('run');
                if (isRunning) {
                    // Continuously ensure status variable matches server connection state
                    updateStatusVariable(isConnectedToCloudflare);
                }
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
                        const syncDataSnapshot = captureSyncDataSnapshot();
                        window.postMessage({
                            type: 'ENTRY_SYNC_ENGINE_STOP',
                            dataOnlySnapshot: dataOnlySnapshot,
                            syncDataSnapshot: syncDataSnapshot
                        }, '*');
                    }
                }
            }
        }
    }, 200);

})();
