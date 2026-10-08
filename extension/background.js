/**
 * Entry Sync - Background Service Worker
 * Opens the update notification page ONLY when Chrome is launched (onStartup),
 * preventing unexpected popups while the user is actively working.
 */

// Helper to check and open pending update page on startup
async function checkAndOpenUpdatePage() {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const storageKey = `seen_update_page_${currentVersion}`;
    const result = await chrome.storage.local.get([storageKey, 'pending_update_version', 'update_notice_enabled']);

    // Check if update notification page option is turned off by user
    if (result.update_notice_enabled === false) {
      return;
    }

    // Check if there is a pending update or if current version update page hasn't been seen yet
    if (!result[storageKey] && result.pending_update_version === currentVersion) {
      await chrome.storage.local.set({ [storageKey]: true });
      await chrome.storage.local.remove('pending_update_version');

      chrome.tabs.create({
        url: 'https://entry-sync-site.pages.dev/update'
      });
    }
  } catch (err) {
    console.error('[Entry Sync Background] Error checking update page on startup:', err);
  }
}

// 1. When extension is updated or installed in background:
// Do NOT open tab immediately during active session. Just record pending version.
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'update' || details.reason === 'install') {
    const currentVersion = chrome.runtime.getManifest().version;
    const storageKey = `seen_update_page_${currentVersion}`;

    try {
      const result = await chrome.storage.local.get([storageKey, 'update_notice_enabled']);
      if (result.update_notice_enabled === false) {
        return;
      }
      if (!result[storageKey]) {
        // Mark pending so onStartup will open it next time Chrome is opened
        await chrome.storage.local.set({ pending_update_version: currentVersion });
      }
    } catch (err) {
      console.error('[Entry Sync Background] Error in onInstalled handler:', err);
    }
  }
});

// 2. When Chrome browser starts / is opened:
chrome.runtime.onStartup.addListener(() => {
  checkAndOpenUpdatePage();
});
