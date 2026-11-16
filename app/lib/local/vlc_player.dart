import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'local_player.dart';

/// Plays a file in a VLC window and controls it through VLC's built-in HTTP
/// interface, which listens only on this machine and needs a password we
/// generate for each launch. (Same approach as Synaxis.)
///
/// Positions: VLC reports whole seconds for `time` and `length`, but a precise
/// fraction for `position`. We use fraction x length both to read and to seek.
/// When the real length isn't a whole number of seconds this is off by a
/// fraction of a second, identically on both partners' machines for the same
/// file, so it doesn't affect sync.
class VlcPlayer implements LocalPlayer {
  VlcPlayer({String? executable}) : _executable = executable ?? findVlc();

  static const _pollInterval = Duration(milliseconds: 250);

  final String _executable;
  final _snapshots = StreamController<LocalSnapshot>.broadcast();
  final _http = http.Client();

  Process? _process;
  Timer? _poll;
  int _port = 0;
  String _password = '';
  double _duration = 0;

  @override
  Stream<LocalSnapshot> get snapshots => _snapshots.stream;

  @override
  Future<void> open(String path) async {
    await close();
    _port = await _freeLocalPort();
    _password = _randomPassword();
    final process = await Process.start(_executable, vlcArguments(path, _port, _password));
    _process = process;
    // VLC is chatty on stderr; drain both pipes so it never blocks on them.
    process.stdout.drain<void>();
    process.stderr.drain<void>();
    process.exitCode.then((_) {
      if (_process == process) _markClosed();
    });
    _poll = Timer.periodic(_pollInterval, (_) => _refresh());
  }

  @override
  Future<void> play() => _command('pl_forceresume');

  @override
  Future<void> pause() => _command('pl_forcepause');

  @override
  Future<void> seek(double seconds) async {
    if (_duration <= 0) return;
    final percent = (seconds / _duration * 100).clamp(0, 100);
    await _command('seek', '${percent.toStringAsFixed(5)}%');
  }

  @override
  Future<void> setRate(double rate) => _command('rate', rate.toString());

  @override
  Future<void> close() async {
    final process = _process;
    _markClosed();
    process?.kill();
  }

  void _markClosed() {
    _poll?.cancel();
    _poll = null;
    _process = null;
    _duration = 0;
    if (!_snapshots.isClosed) _snapshots.add(LocalSnapshot.closed);
  }

  Future<void> _refresh() => _command(null);

  /// Sends a command (or just asks for status when [command] is null) and
  /// publishes the status VLC answers with.
  Future<void> _command(String? command, [String? value]) async {
    if (_process == null) return;
    final uri = Uri.http('127.0.0.1:$_port', '/requests/status.json', {
      'command': ?command,
      'val': ?value,
    });
    try {
      final response = await _http
          .get(uri, headers: {'Authorization': 'Basic ${base64Encode(utf8.encode(':$_password'))}'})
          .timeout(const Duration(seconds: 2));
      final snapshot = parseVlcStatus(response.body);
      if (snapshot == null || _process == null) return;
      _duration = snapshot.duration;
      _snapshots.add(snapshot);
    } on Exception {
      // VLC is still starting, or just closed. The next poll tries again.
    }
  }
}

/// The command line that starts VLC with its control interface on.
List<String> vlcArguments(String path, int port, String password) => [
      // A separate instance, even if the user's VLC is set to reuse one:
      // otherwise the file is handed off and our control port never opens.
      '--no-one-instance',
      '--no-playlist-enqueue',
      '--extraintf=http',
      '--http-host=127.0.0.1',
      '--http-port=$port',
      '--http-password=$password',
      // The room decides where playback starts, not VLC's resume prompt.
      '--qt-continue=0',
      '--no-loop',
      '--no-repeat',
      '--no-random',
      path,
    ];

/// Reads VLC's status.json. Returns null if it isn't a status reply.
LocalSnapshot? parseVlcStatus(String body) {
  final Object? json;
  try {
    json = jsonDecode(body);
  } on FormatException {
    return null;
  }
  if (json is! Map<String, dynamic> || json['state'] is! String) return null;

  final duration = (json['length'] as num?)?.toDouble() ?? 0;
  final fraction = (json['position'] as num?)?.toDouble() ?? 0;
  return LocalSnapshot(
    isOpen: json['state'] != 'stopped',
    isPlaying: json['state'] == 'playing',
    position: duration > 0 ? fraction * duration : 0,
    duration: duration > 0 ? duration : 0,
    rate: (json['rate'] as num?)?.toDouble() ?? 1,
  );
}

/// Where VLC is installed, or just "vlc" to let the system search for it.
String findVlc() {
  if (Platform.isWindows) {
    for (final variable in ['ProgramFiles', 'ProgramFiles(x86)']) {
      final root = Platform.environment[variable];
      if (root == null) continue;
      final exe = File('$root\\VideoLAN\\VLC\\vlc.exe');
      if (exe.existsSync()) return exe.path;
    }
  }
  return 'vlc';
}

Future<int> _freeLocalPort() async {
  final socket = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
  final port = socket.port;
  await socket.close();
  return port;
}

String _randomPassword() {
  final random = Random.secure();
  return List.generate(16, (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();
}
