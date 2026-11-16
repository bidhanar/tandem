import 'dart:io';

import 'package:flutter/services.dart' show rootBundle;

/// Serves assets/player.html on a random port of http://127.0.0.1.
///
/// YouTube refuses to play in a page that has no web address (error 153), so
/// the page can't be loaded from a string or a file. Serving it from this
/// machine gives it one. Nothing outside this computer can reach it.
class PlayerPageServer {
  HttpServer? _server;

  /// Starts the server if needed and returns the page's address.
  Future<Uri> start() async {
    var server = _server;
    if (server == null) {
      final html = await rootBundle.loadString('assets/player.html');
      server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      _server = server;
      server.listen((request) {
        request.response
          ..headers.contentType = ContentType.html
          ..write(html)
          ..close();
      });
    }
    return Uri.parse('http://127.0.0.1:${server.port}/');
  }

  Future<void> stop() async {
    await _server?.close(force: true);
    _server = null;
  }
}
