/**
 * Entry Sync - Background Service Worker
 * Handles extension update events and opens the update notification page exactly once per version update.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'update' || details.reason === 'install') {
    const currentVersion = chrome.runtime.getManifest().version;
    const storageKey = `seen_update_page_${currentVersion}`;

    try {
      // Check if update page has already been displayed for this version
      const result = await chrome.storage.local.get(storageKey);
      if (!result[storageKey]) {
        // Mark as shown for this version
        await chrome.storage.local.set({ [storageKey]: true });

        // Open official update notification page (/update)
        chrome.tabs.create({
          url: 'https://entry-sync-site.pages.dev/update'
        });
      }
    } catch (err) {
      console.error('[Entry Sync Background] Error handling onInstalled event:', err);
    }
  }
});
