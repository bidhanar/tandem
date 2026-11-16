import 'dart:async';
import 'dart:convert';

import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'player_page_server.dart';
import 'youtube_player_adapter.dart';

/// YouTube through flutter_inappwebview (WebView2 on Windows).
class InAppWebViewYouTubeAdapter implements YouTubePlayerAdapter {
  final _pageServer = PlayerPageServer();
  final _ready = Completer<void>();
  final _snapshots = StreamController<YouTubeSnapshot>.broadcast();
  final _errors = StreamController<int>.broadcast();
  InAppWebViewController? _webView;

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<YouTubeSnapshot> get snapshots => _snapshots.stream;

  @override
  Stream<int> get errors => _errors.stream;

  @override
  Widget buildView() {
    return FutureBuilder<Uri>(
      future: _pageServer.start(),
      builder: (context, page) {
        if (!page.hasData) return const SizedBox.expand();
        return InAppWebView(
          initialUrlRequest: URLRequest(url: WebUri.uri(page.data!)),
          initialSettings: InAppWebViewSettings(
            // A play command from the partner must start the video without
            // anyone tapping this device.
            mediaPlaybackRequiresUserGesture: false,
            transparentBackground: true,
          ),
          onWebViewCreated: (controller) {
            _webView = controller;
            controller.addJavaScriptHandler(
              handlerName: 'syncus',
              callback: (args) => _onMessage(args.first as String),
            );
          },
        );
      },
    );
  }

  void _onMessage(String json) {
    final message = jsonDecode(json) as Map<String, dynamic>;
    switch (message['type']) {
      case 'ready':
        if (!_ready.isCompleted) _ready.complete();
      case 'tick':
        _snapshots.add(YouTubeSnapshot(
          state: YouTubeState.fromCode((message['state'] as num).toInt()),
          position: (message['position'] as num).toDouble(),
          duration: (message['duration'] as num).toDouble(),
          rate: (message['rate'] as num).toDouble(),
        ));
      case 'error':
        _errors.add((message['code'] as num).toInt());
    }
  }

  Future<void> _run(String script) async {
    await ready;
    await _webView?.evaluateJavascript(source: script);
  }

  @override
  Future<void> load(String videoId, {double startSeconds = 0}) =>
      _run('syncus.load(${jsonEncode(videoId)}, $startSeconds)');

  @override
  Future<void> play() => _run('syncus.play()');

  @override
  Future<void> pause() => _run('syncus.pause()');

  @override
  Future<void> seek(double seconds) => _run('syncus.seek($seconds)');

  @override
  void dispose() {
    _pageServer.stop();
    _snapshots.close();
    _errors.close();
  }
}
