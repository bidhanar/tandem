// The extension's background script: only the "Add to Tandem queue" item in
// the menu you get by right-clicking a YouTube video link. The room itself
// lives in the YouTube tab (tandem.js), so the click is passed on to it.
//
// Chrome runs this as a service worker, Firefox as an event page; the
// manifest names it for both.

const MENU_ID = 'tandem-queue';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Add to Tandem queue',
    contexts: ['link'],
    targetUrlPatterns: [
      'https://www.youtube.com/watch*',
      'https://youtu.be/*',
      'https://www.youtube.com/shorts/*',
    ],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || tab?.id === undefined) return;
  // A tab without Tandem (not youtube.com) can't answer; nothing to do then.
  chrome.tabs.sendMessage(tab.id, { do: 'queue-add', link: info.linkUrl }).catch(() => {});
});
