// The extension's popup. Settings live in the extension's storage; the room
// itself is run by tandem.js in the YouTube tab, which this asks for its
// status and tells to create, join or leave.

import { DEFAULT_SERVER } from './defaults.js';

const $ = (selector) => document.querySelector(selector);
let tabId = null;
let busy = false;
let away = false; // you told the room you're away (AFK)
let chatShown = ''; // the messages drawn last, to redraw only when they change
let queueShown = ''; // likewise for the queue
let invite = null; // the room's invite link

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
    $('#partner').textContent = status.partner;
    $('#partner').className = status.partners; // 'here', 'away' or 'offline': the dot's colour
    $('#line').textContent = status.line;
    $('#chosen').textContent = status.chosen && `This video: ${status.chosen}`;
    away = status.away;
    $('#away').textContent = away ? "I'm back" : "I'm away";
    $('#away').classList.toggle('on', away);
    drawChat(status.chat);
    drawQueue(status.queue);
    invite = status.invite;
    $('#quality').textContent = status.quality.join('\n');
    $('#typing').textContent = status.typing;
    $('#resume').hidden = !status.resumable;
    if (document.activeElement !== $('#pause-on-away')) $('#pause-on-away').checked = status.options.pauseOnAway;
  } else {
    show('lobby');
  }
  if (busy && status.connection === 'connecting') $('#message').textContent = status.message || 'Connecting…';
  else $('#message').textContent = status.message || '';
}

/** The room's latest messages, oldest first. Plain text only: they come from other people. */
function drawChat(messages) {
  const key = JSON.stringify(messages.map((m) => [m.at, m.text]));
  if (key === chatShown) return;
  chatShown = key;
  const log = $('#log');
  if (!messages.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = 'Messages go to everyone in the room.';
    log.replaceChildren(empty);
    return;
  }
  log.replaceChildren(...messages.map((m) => {
    const line = document.createElement('p');
    line.className = m.mine ? 'msg mine' : 'msg';
    line.title = new Date(m.at).toLocaleTimeString();
    const who = document.createElement('b');
    who.textContent = m.mine ? 'You' : m.name;
    line.append(who, m.text);
    return line;
  }));
  log.scrollTop = log.scrollHeight;
}

/** The room's queue, with buttons to play an entry now or take it out. */
function drawQueue(queue) {
  const key = JSON.stringify(queue);
  if (key === queueShown) return;
  queueShown = key;
  $('#queue-title').textContent = queue.length ? `Up next · ${queue.length}` : 'Queue';
  $('#queue-clear').hidden = !queue.length;
  $('#queue-list').replaceChildren(...queue.map((item) => {
    const li = document.createElement('li');
    const picture = document.createElement('img');
    picture.src = `https://i.ytimg.com/vi/${item.mediaId}/mqdefault.jpg`;
    picture.alt = '';
    const what = document.createElement('div');
    what.className = 'what';
    const title = document.createElement('b');
    title.textContent = item.title ?? 'YouTube video';
    const by = document.createElement('span');
    by.textContent = `added by ${item.by}`;
    what.append(title, by);
    const play = button('▶', 'Play this now, for everyone', () => act({ do: 'queue-play', id: item.id }));
    const remove = button('✕', 'Take it out of the queue', () => act({ do: 'queue-remove', id: item.id }));
    li.append(picture, what, play, remove);
    return li;
  }));
}

function button(text, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn';
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

async function refresh() {
  // `seen`: the chat is in front of the person, so the badge's unread count can go.
  if (tabId !== null) draw(await askTab({ do: 'status', seen: true }));
}

/** Create, join or leave. Disables the buttons until the tab answers. */
async function act(message) {
  busy = true;
  document.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  $('#message').textContent = message.do === 'create' || message.do === 'join' ? 'Connecting…' : '';
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
  $('#away').addEventListener('click', () => act({ do: 'away', away: !away }));
  $('#say-text').addEventListener('input', () => askTab({ do: 'typing' }));
  $('#resume').addEventListener('click', () => act({ do: 'resume' }));
  $('#queue-clear').addEventListener('click', () => act({ do: 'queue-clear' }));
  $('#pause-on-away').addEventListener('change', () => act({ do: 'options', pauseOnAway: $('#pause-on-away').checked }));
  $('#chat-sound').checked = (await chrome.storage.local.get('chatSound')).chatSound !== false;
  $('#chat-sound').addEventListener('change', () => chrome.storage.local.set({ chatSound: $('#chat-sound').checked }));
  $('#invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(invite);
      $('#invite').textContent = 'Copied: send it to your partner';
    } catch {
      $('#invite').textContent = "Couldn't copy";
    }
    setTimeout(() => { $('#invite').textContent = 'Copy invite link'; }, 2000);
  });
  $('#say').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = $('#say-text').value.trim();
    if (!text) return;
    const status = await askTab({ do: 'chat', text });
    if (status && !status.message) $('#say-text').value = '';
    draw(status);
  });
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
  if (!$('#room').hidden) $('#say-text').focus(); // in a room, the popup opens ready to chat
  setInterval(refresh, 700);
}

start();
