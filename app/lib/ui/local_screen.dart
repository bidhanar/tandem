import 'dart:async';

import 'package:file_selector/file_selector.dart';
import 'package:material_ui/material_ui.dart';
import 'package:path/path.dart' as p;

import '../local/local_player.dart';
import '../local/vlc_player.dart';
import 'theme.dart';
import 'transport_controls.dart';

/// Phase 1 screen: pick a video file, play it in VLC and drive VLC from here.
class LocalScreen extends StatefulWidget {
  const LocalScreen({super.key});

  @override
  State<LocalScreen> createState() => _LocalScreenState();
}

class _LocalScreenState extends State<LocalScreen> {
  static const _videoFiles = XTypeGroup(
    label: 'Videos',
    extensions: ['mkv', 'mp4', 'avi', 'mov', 'webm', 'm4v', 'ts', 'wmv', 'flv', 'mp3', 'flac', 'm4a'],
  );

  final LocalPlayer _player = VlcPlayer();
  late final StreamSubscription<LocalSnapshot> _subscription;

  LocalSnapshot _snapshot = LocalSnapshot.closed;
  String? _fileName;
  String? _message;

  @override
  void initState() {
    super.initState();
    _subscription = _player.snapshots.listen((s) => setState(() => _snapshot = s));
  }

  @override
  void dispose() {
    _subscription.cancel();
    _player.close();
    super.dispose();
  }

  Future<void> _pickFile() async {
    final file = await openFile(acceptedTypeGroups: const [_videoFiles]);
    if (file == null) return;
    try {
      await _player.open(file.path);
      setState(() {
        _fileName = p.basename(file.path);
        _message = null;
      });
    } on Exception {
      setState(() => _message = "Couldn't start VLC. Install it from videolan.org and try again.");
    }
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = _snapshot;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: FilledButton.icon(
              onPressed: _pickFile,
              icon: const Icon(Icons.folder_open),
              label: const Text('Choose a video file'),
            ),
          ),
          if (_message != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(_message!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            ),
          Expanded(
            child: Center(
              child: Text(
                !snapshot.isOpen
                    ? 'The video opens in a VLC window.\nThese controls drive it.'
                    : 'Playing in VLC:\n${_fileName ?? ''}',
                textAlign: TextAlign.center,
                style: const TextStyle(color: AppColors.muted),
              ),
            ),
          ),
          TransportControls(
            enabled: snapshot.isOpen,
            isPlaying: snapshot.isPlaying,
            position: snapshot.position,
            duration: snapshot.duration,
            onPlay: _player.play,
            onPause: _player.pause,
            onSeek: _player.seek,
          ),
          Text(
            snapshot.isOpen
                ? 'Position: ${snapshot.position.toStringAsFixed(2)} s   Speed: ${snapshot.rate.toStringAsFixed(2)}x'
                : 'No file open',
            style: const TextStyle(color: AppColors.muted),
          ),
        ],
      ),
    );
  }
}
