// The extension's popup. Settings live in the extension's storage; the room
// itself is run by tandem.js in the YouTube tab, which this asks for its
// status and tells to create, join or leave.

import { DEFAULT_SERVER } from './defaults.js';

const $ = (selector) => document.querySelector(selector);
let tabId = null;
let busy = false;

/** A question to the YouTube tab. Null if Tandem isn't running there. */
async function askTab(message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

function show(id) {
  for (const section of ['elsewhere', 'lobby', 'room']) $(`#${section}`).hidden = section !== id;
  $('#settings').hidden = id !== 'lobby';
}

function draw(status) {
  if (!status) {
    show('elsewhere');
    $('#message').textContent = '';
    return;
  }
  if (status.room) {
    show('room');
    $('#room-code').textContent = status.room.code;
    const partnerHere = status.room.people.some((p) => !p.you && p.online);
    $('#partner').textContent = status.partner;
    $('#partner').classList.toggle('online', partnerHere);
    $('#line').textContent = status.line;
  } else {
    show('lobby');
  }
  if (busy && status.connection === 'connecting') $('#message').textContent = status.message || 'Connecting…';
  else $('#message').textContent = status.message || '';
}

async function refresh() {
  if (tabId !== null) draw(await askTab({ do: 'status' }));
}

/** Create, join or leave. Disables the buttons until the tab answers. */
async function act(message) {
  busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  $('#message').textContent = message.do === 'leave' ? '' : 'Connecting…';
  const status = await askTab(message);
  busy = false;
  document.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  draw(status);
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id ?? null;

  const saved = await chrome.storage.local.get(['name', 'server']);
  $('#name').value = saved.name ?? '';
  $('#server').value = saved.server || DEFAULT_SERVER;

  $('#name').addEventListener('change', () => chrome.storage.local.set({ name: $('#name').value.trim() }));
  $('#server').addEventListener('change', () => {
    const server = $('#server').value.trim().replace(/\/+$/, '');
    $('#server').value = server || DEFAULT_SERVER;
    chrome.storage.local.set({ server });
  });

  $('#open-youtube').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.youtube.com/' });
    window.close();
  });
  $('#create').addEventListener('click', async () => {
    await chrome.storage.local.set({ name: $('#name').value.trim() });
    act({ do: 'create' });
  });
  $('#join-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await chrome.storage.local.set({ name: $('#name').value.trim() });
    act({ do: 'join', code: $('#code').value.trim() });
  });
  $('#leave').addEventListener('click', () => act({ do: 'leave' }));
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#room-code').textContent);
      $('#copy').textContent = 'Copied';
    } catch {
      $('#copy').textContent = 'Select it';
    }
    setTimeout(() => { $('#copy').textContent = 'Copy'; }, 1500);
  });

  await refresh();
  setInterval(refresh, 700);
}

start();
