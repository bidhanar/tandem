// Runs inside youtube.com's own page, where YouTube's player and its
// in-page navigation can be reached. The rest of the extension runs apart
// from the page (browsers keep extension code and page code separate), so it
// asks through here: it puts a command in the data-tandem-command attribute
// of <html> and fires a 'tandem:command' event. Events run at once, so the
// answer is in data-tandem-answer by the time the event call returns.
//
// Commands: { do: 'read' } answers what the player is doing, 'page' what page
// YouTube is showing; 'play', 'pause',
// 'seek' {seconds}, 'rate' {rate} control it; 'go' {path} opens another
// youtube.com page the way YouTube's own links do, without reloading the tab.

(() => {
  const root = document.documentElement;

  // An invite link (…#tandem=CODE): keep it for the extension, which reads it
  // when it starts, and take it out of the address before YouTube sees it.
  if (/(?:^#|&)tandem=/.test(location.hash)) {
    root.setAttribute('data-tandem-invite', location.hash);
    history.replaceState(history.state, '', location.pathname + location.search);
  }

  function read() {
    const player = document.getElementById('movie_player');
    if (!player?.getPlayerState) return null;
    const video = player.getVideoData?.() ?? {};
    return {
      videoId: video.video_id || null,
      title: video.title || null,
      state: player.getPlayerState(), // -1 not started, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
      time: player.getCurrentTime() || 0,
      rate: player.getPlaybackRate() || 1,
      ad: player.classList.contains('ad-showing'),
    };
  }

  /** The page YouTube is showing: its address, and the channel's id on a channel page. */
  function page() {
    const data = document.querySelector('ytd-app')?.data;
    return {
      url: data?.endpoint?.commandMetadata?.webCommandMetadata?.url ?? null,
      channelId: data?.page === 'channel' ? data.endpoint?.browseEndpoint?.browseId ?? null : null,
    };
  }

  function go(path) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return;
    const app = document.querySelector('ytd-app');
    if (!app) return void location.assign(path); // not the usual site layout: an ordinary page load
    app.dispatchEvent(new CustomEvent('yt-navigate', {
      bubbles: true,
      composed: true,
      detail: { endpoint: { commandMetadata: { webCommandMetadata: { url: path } } } },
    }));
  }

  document.addEventListener('tandem:command', () => {
    let command;
    try {
      command = JSON.parse(root.getAttribute('data-tandem-command'));
    } catch {
      return;
    }
    root.removeAttribute('data-tandem-command');
    const player = document.getElementById('movie_player');
    let answer = null;
    try {
      switch (command?.do) {
        case 'read': answer = read(); break;
        case 'page': answer = page(); break;
        case 'play': player?.playVideo(); break;
        case 'pause': player?.pauseVideo(); break;
        case 'seek': player?.seekTo(Number(command.seconds) || 0, true); break;
        case 'rate': player?.setPlaybackRate(Number(command.rate) || 1); break;
        case 'go': go(command.path); break;
        default: break;
      }
    } catch { /* YouTube changed something; the answer stays empty */ }
    root.setAttribute('data-tandem-answer', JSON.stringify(answer));
  });
})();
