// Manual check of VlcPlayer against a real VLC, without the Flutter UI:
//   dart run tool/vlc_probe.dart <video file> [vlc executable]
// Plays, pauses, seeks and changes speed, printing what VLC reports.
import 'dart:io';

import 'package:mendu/local/local_player.dart';
import 'package:mendu/local/vlc_player.dart';

Future<void> main(List<String> args) async {
  final player = VlcPlayer(executable: args.length > 1 ? args[1] : null);
  final clock = Stopwatch()..start();
  LocalSnapshot last = LocalSnapshot.closed;
  player.snapshots.listen((s) {
    last = s;
    stdout.writeln('${(clock.elapsedMilliseconds / 1000).toStringAsFixed(2)}s  '
        'open=${s.isOpen} playing=${s.isPlaying} '
        'pos=${s.position.toStringAsFixed(3)} dur=${s.duration} rate=${s.rate}');
  });

  Future<void> step(String label, Future<void> Function() action, int waitMs) async {
    stdout.writeln('--- $label');
    await action();
    await Future<void>.delayed(Duration(milliseconds: waitMs));
  }

  await step('open', () => player.open(args[0]), 3000);
  await step('pause', player.pause, 1200);
  await step('seek to 42.5', () => player.seek(42.5), 1200);
  await step('play', player.play, 2000);
  await step('rate 1.05', () => player.setRate(1.05), 2000);
  await step('rate 1.0', () => player.setRate(1.0), 800);
  await step('close', player.close, 500);
  stdout.writeln('last: open=${last.isOpen}');
  exit(0);
}
