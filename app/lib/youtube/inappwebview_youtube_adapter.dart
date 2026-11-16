import 'package:flutter/widgets.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';

import 'page_bridge_adapter.dart';
import 'player_page_server.dart';

/// YouTube through flutter_inappwebview (WebView2 on Windows).
class InAppWebViewYouTubeAdapter extends PageBridgeAdapter {
  final _pageServer = PlayerPageServer();
  InAppWebViewController? _webView;

  @override
  Widget buildView() {
    return FutureBuilder<Uri>(
      future: _pageServer.start(),
      builder: (context, page) {
        if (!page.hasData) return const SizedBox.expand();
        return InAppWebView(
          initialUrlRequest: URLRequest(url: WebUri.uri(page.data!)),
          initialSettings: InAppWebViewSettings(
            // A play command from the partner must start the video without
            // anyone tapping this device.
            mediaPlaybackRequiresUserGesture: false,
            transparentBackground: true,
          ),
          onWebViewCreated: (controller) {
            _webView = controller;
            controller.addJavaScriptHandler(
              handlerName: 'mendu',
              callback: (args) => onPageMessage(args.first as String),
            );
          },
        );
      },
    );
  }

  @override
  Future<void> evaluate(String script) async {
    await _webView?.evaluateJavascript(source: script);
  }

  @override
  void dispose() {
    _pageServer.stop();
    super.dispose();
  }
}
