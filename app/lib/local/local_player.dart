/// What a local-file player reported at one moment. Times are in seconds.
class LocalSnapshot {
  const LocalSnapshot({
    required this.isOpen,
    required this.isPlaying,
    required this.position,
    required this.duration,
    required this.rate,
  });

  /// Nothing loaded, or the player was closed.
  static const closed = LocalSnapshot(
      isOpen: false, isPlaying: false, position: 0, duration: 0, rate: 1);

  final bool isOpen;
  final bool isPlaying;
  final double position;
  final double duration;
  final double rate;
}

/// A player for a file on this device. VLC on Windows and Linux today; the
/// sync code only uses this interface, so another player can replace it.
abstract class LocalPlayer {
  /// A snapshot about four times a second while a file is open.
  Stream<LocalSnapshot> get snapshots;

  Future<void> open(String path);
  Future<void> play();
  Future<void> pause();
  Future<void> seek(double seconds);

  /// 1.0 is normal speed. Drift correction nudges this slightly.
  Future<void> setRate(double rate);

  Future<void> close();
}
