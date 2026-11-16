import 'dart:io';

import 'package:flutter/widgets.dart';

import 'inappwebview_youtube_adapter.dart';

/// The IFrame API's player states (the numbers are YouTube's).
enum YouTubeState {
  unstarted(-1),
  ended(0),
  playing(1),
  paused(2),
  buffering(3),
  cued(5);

  const YouTubeState(this.code);
  final int code;

  static YouTubeState fromCode(int code) =>
      values.firstWhere((s) => s.code == code, orElse: () => unstarted);
}

/// What the player reported at one moment. Times are in seconds.
class YouTubeSnapshot {
  const YouTubeSnapshot({
    required this.state,
    required this.position,
    required this.duration,
    required this.rate,
  });

  final YouTubeState state;
  final double position;
  final double duration;
  final double rate;
}

/// The official embedded YouTube player, however a platform hosts it.
///
/// Each platform's WebView gets its own implementation; the rest of the app
/// only uses this interface.
abstract class YouTubePlayerAdapter {
  /// The player itself. Must stay visible and at least 200x200 (YouTube ToS).
  Widget buildView();

  /// Completes once the IFrame API has loaded and commands will be obeyed.
  Future<void> get ready;

  /// A snapshot about four times a second, and on every state change.
  Stream<YouTubeSnapshot> get snapshots;

  /// IFrame API error codes (2, 5, 100, 101, 150, 153).
  Stream<int> get errors;

  Future<void> load(String videoId, {double startSeconds = 0});
  Future<void> play();
  Future<void> pause();
  Future<void> seek(double seconds);

  void dispose();
}

/// The adapter for this platform, or null where YouTube isn't supported yet.
YouTubePlayerAdapter? createYouTubePlayerAdapter() {
  if (Platform.isWindows) return InAppWebViewYouTubeAdapter();
  return null; // Linux: WebView choice still to be made.
}

/// A message for the person watching, for an IFrame API error code.
String youTubeErrorMessage(int code) {
  switch (code) {
    case 2:
      return "That link doesn't point to a valid video.";
    case 5:
      return "This video can't be played in the embedded player.";
    case 100:
      return 'This video was removed or is private.';
    case 101:
    case 150:
      return "The owner of this video doesn't allow it to be played outside "
          'YouTube. Pick another video.';
    case 153:
      return 'YouTube rejected the player (error 153). This is a problem with '
          'the app, not the video.';
    default:
      return 'YouTube reported error $code.';
  }
}
