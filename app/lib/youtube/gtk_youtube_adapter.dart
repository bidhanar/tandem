import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'page_bridge_adapter.dart';
import 'player_page_server.dart';

/// YouTube on Linux. Flutter has no web view widget there, so the app's own
/// window code (linux/runner/youtube_view.cc) lays a WebKitGTK view over the
/// Flutter view. This adapter tells it where: [buildView] returns an empty
/// box, and the web view is kept exactly on top of that box.
///
/// Because the web view sits above everything Flutter draws, menus and
/// dialogs can't appear over the player.
class GtkYouTubeAdapter extends PageBridgeAdapter {
  GtkYouTubeAdapter() {
    _channel.setMethodCallHandler((call) async {
      if (call.method == 'message') onPageMessage(call.arguments as String);
    });
    _pageServer.start().then((page) => _channel.invokeMethod('create', page.toString()));
  }

  static const _channel = MethodChannel('mendu/youtube_view');
  final _pageServer = PlayerPageServer();

  @override
  Widget buildView() => _WebViewPlaceholder(channel: _channel);

  @override
  Future<void> evaluate(String script) => _channel.invokeMethod('eval', script);

  @override
  void dispose() {
    _channel.invokeMethod('dispose');
    _channel.setMethodCallHandler(null);
    _pageServer.stop();
    super.dispose();
  }
}

/// An empty box that keeps the native web view placed over itself.
class _WebViewPlaceholder extends StatefulWidget {
  const _WebViewPlaceholder({required this.channel});
  final MethodChannel channel;

  @override
  State<_WebViewPlaceholder> createState() => _WebViewPlaceholderState();
}

class _WebViewPlaceholderState extends State<_WebViewPlaceholder> {
  Rect? _sentFrame;

  @override
  void initState() {
    super.initState();
    _checkAfterNextFrame();
  }

  @override
  void dispose() {
    _send(Rect.zero);
    super.dispose();
  }

  /// Re-checks the box's place on screen after every frame Flutter draws.
  /// This doesn't cause extra frames; it only rides along with real ones.
  void _checkAfterNextFrame() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _send(_frameOnScreen());
      _checkAfterNextFrame();
    });
  }

  /// Where the box is in the window, or [Rect.zero] when it isn't showing
  /// (for example while another tab is open).
  Rect _frameOnScreen() {
    final box = context.findRenderObject();
    if (box is! RenderBox || !box.attached || !box.hasSize) return Rect.zero;
    final frame = box.localToGlobal(Offset.zero) & box.size;
    final window = Offset.zero & MediaQuery.sizeOf(context);
    return window.contains(frame.topLeft) && window.contains(frame.bottomRight - const Offset(1, 1))
        ? frame
        : Rect.zero;
  }

  void _send(Rect frame) {
    if (frame == _sentFrame) return;
    _sentFrame = frame;
    widget.channel.invokeMethod('setFrame', [frame.left, frame.top, frame.width, frame.height]);
  }

  @override
  Widget build(BuildContext context) => const SizedBox.expand();
}
