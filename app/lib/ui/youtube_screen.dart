import 'dart:async';

import 'package:material_ui/material_ui.dart';

import '../youtube/youtube_player_adapter.dart';
import '../youtube/youtube_url.dart';
import 'theme.dart';
import 'transport_controls.dart';

/// Phase 1 screen: paste a YouTube link, play it in the embedded player and
/// drive it from Flutter.
class YouTubeScreen extends StatefulWidget {
  const YouTubeScreen({super.key, this.initialLink});

  /// A link to load as soon as the player is ready.
  final String? initialLink;

  @override
  State<YouTubeScreen> createState() => _YouTubeScreenState();
}

class _YouTubeScreenState extends State<YouTubeScreen> {
  final _url = TextEditingController();
  final YouTubePlayerAdapter? _player = createYouTubePlayerAdapter();
  final _subscriptions = <StreamSubscription<void>>[];

  YouTubeSnapshot? _snapshot;
  String? _message;

  @override
  void initState() {
    super.initState();
    final player = _player;
    if (player == null) return;
    _subscriptions.add(player.snapshots.listen((s) => setState(() => _snapshot = s)));
    _subscriptions.add(player.errors.listen(
      (code) => setState(() => _message = youTubeErrorMessage(code)),
    ));
    if (widget.initialLink != null) {
      _url.text = widget.initialLink!;
      _load();
    }
  }

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _player?.dispose();
    _url.dispose();
    super.dispose();
  }

  void _load() {
    final id = parseYouTubeVideoId(_url.text);
    setState(() => _message = id == null ? "That doesn't look like a YouTube video link." : null);
    if (id != null) _player!.load(id);
  }

  @override
  Widget build(BuildContext context) {
    final player = _player;
    if (player == null) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            "YouTube isn't available on this kind of device yet.",
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    final snapshot = _snapshot;
    final state = snapshot?.state ?? YouTubeState.unstarted;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _url,
                  decoration: const InputDecoration(hintText: 'Paste a YouTube link'),
                  onSubmitted: (_) => _load(),
                ),
              ),
              const SizedBox(width: 12),
              FilledButton(onPressed: _load, child: const Text('Load')),
            ],
          ),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_message!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          const SizedBox(height: 12),
          Expanded(
            child: ConstrainedBox(
              // YouTube requires the player to stay at least 200x200.
              constraints: const BoxConstraints(minWidth: 200, minHeight: 200),
              child: ColoredBox(color: Colors.black, child: player.buildView()),
            ),
          ),
          const SizedBox(height: 8),
          TransportControls(
            enabled: snapshot != null,
            isPlaying: state == YouTubeState.playing || state == YouTubeState.buffering,
            position: snapshot?.position ?? 0,
            duration: snapshot?.duration ?? 0,
            onPlay: player.play,
            onPause: player.pause,
            onSeek: player.seek,
          ),
          Text(
            snapshot == null
                ? 'Player loading…'
                : 'State: ${state.name}   Position: ${snapshot.position.toStringAsFixed(2)} s',
            style: const TextStyle(color: AppColors.muted),
          ),
        ],
      ),
    );
  }
}
