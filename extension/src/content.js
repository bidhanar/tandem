// Content scripts can't be modules, so this only loads the one that is.
import(chrome.runtime.getURL('tandem.js')).catch((error) => console.error('Tandem could not start:', error));
