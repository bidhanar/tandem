import 'package:flutter_test/flutter_test.dart';
import 'package:syncus/local/vlc_player.dart';

void main() {
  test('reads a playing status, using the precise fraction for position', () {
    final s = parseVlcStatus(
        '{"state":"playing","time":42,"length":90,"position":0.4725,"rate":1.05}')!;
    expect(s.isOpen, isTrue);
    expect(s.isPlaying, isTrue);
    expect(s.position, closeTo(42.525, 1e-9));
    expect(s.duration, 90);
    expect(s.rate, 1.05);
  });

  test('paused and stopped states', () {
    final paused = parseVlcStatus('{"state":"paused","length":90,"position":0.5,"rate":1}')!;
    expect(paused.isOpen, isTrue);
    expect(paused.isPlaying, isFalse);

    final stopped = parseVlcStatus('{"state":"stopped","length":-1,"position":0,"rate":1}')!;
    expect(stopped.isOpen, isFalse);
    expect(stopped.position, 0);
    expect(stopped.duration, 0);
  });

  test('ignores replies that are not a status', () {
    expect(parseVlcStatus('<html>401 Unauthorized</html>'), isNull);
    expect(parseVlcStatus('[]'), isNull);
    expect(parseVlcStatus('{"length":90}'), isNull);
  });

  test('command line opens the control interface on this machine only', () {
    final args = vlcArguments('/videos/film.mkv', 4242, 'secret');
    expect(args, containsAll(['--extraintf=http', '--http-host=127.0.0.1', '--http-port=4242',
        '--http-password=secret', '--no-one-instance']));
    expect(args.last, '/videos/film.mkv');
  });
}
