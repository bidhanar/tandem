import 'package:material_ui/material_ui.dart';

/// Play/pause button, seek bar and time readout, used by both players.
class TransportControls extends StatefulWidget {
  const TransportControls({
    super.key,
    required this.isPlaying,
    required this.position,
    required this.duration,
    required this.onPlay,
    required this.onPause,
    required this.onSeek,
    this.enabled = true,
  });

  final bool isPlaying;
  final double position;
  final double duration;
  final VoidCallback onPlay;
  final VoidCallback onPause;
  final ValueChanged<double> onSeek;
  final bool enabled;

  @override
  State<TransportControls> createState() => _TransportControlsState();
}

class _TransportControlsState extends State<TransportControls> {
  /// Where the thumb is while the user drags it; null when they aren't.
  double? _dragPosition;

  @override
  Widget build(BuildContext context) {
    final duration = widget.duration;
    final canSeek = widget.enabled && duration > 0;
    final shown = (_dragPosition ?? widget.position).clamp(0.0, duration > 0 ? duration : 0.0);

    return Row(
      children: [
        IconButton.filled(
          tooltip: widget.isPlaying ? 'Pause' : 'Play',
          onPressed: !widget.enabled ? null : (widget.isPlaying ? widget.onPause : widget.onPlay),
          icon: Icon(widget.isPlaying ? Icons.pause : Icons.play_arrow),
        ),
        Expanded(
          child: Slider(
            value: shown,
            max: duration > 0 ? duration : 1,
            onChanged: canSeek ? (value) => setState(() => _dragPosition = value) : null,
            onChangeEnd: canSeek
                ? (value) {
                    setState(() => _dragPosition = null);
                    widget.onSeek(value);
                  }
                : null,
          ),
        ),
        Text(
          '${formatTime(shown)} / ${formatTime(duration)}',
          style: const TextStyle(fontFeatures: [FontFeature.tabularFigures()]),
        ),
      ],
    );
  }
}

/// 75.4 -> "1:15", 3725 -> "1:02:05".
String formatTime(double seconds) {
  final total = seconds.isFinite ? seconds.floor() : 0;
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = (total % 60).toString().padLeft(2, '0');
  return h > 0 ? '$h:${m.toString().padLeft(2, '0')}:$s' : '$m:$s';
}
