import 'dart:async';
import 'dart:convert';

import 'youtube_player_adapter.dart';

/// The part every platform shares: understanding the messages the player
/// page (assets/player.html) sends, and turning commands into script calls.
/// A platform adapter only has to show the page, feed its messages to
/// [onPageMessage] and implement [evaluate].
abstract class PageBridgeAdapter implements YouTubePlayerAdapter {
  final _ready = Completer<void>();
  final _snapshots = StreamController<YouTubeSnapshot>.broadcast();
  final _errors = StreamController<int>.broadcast();

  /// Runs JavaScript in the player page.
  Future<void> evaluate(String script);

  /// Call with each JSON message the page posts.
  void onPageMessage(String json) {
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

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<YouTubeSnapshot> get snapshots => _snapshots.stream;

  @override
  Stream<int> get errors => _errors.stream;

  Future<void> _run(String script) async {
    await ready;
    await evaluate(script);
  }

  @override
  Future<void> load(String videoId, {double startSeconds = 0}) =>
      _run('mendu.load(${jsonEncode(videoId)}, $startSeconds)');

  @override
  Future<void> play() => _run('mendu.play()');

  @override
  Future<void> pause() => _run('mendu.pause()');

  @override
  Future<void> seek(double seconds) => _run('mendu.seek($seconds)');

  @override
  void dispose() {
    _snapshots.close();
    _errors.close();
  }
}
