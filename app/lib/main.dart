import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:material_ui/material_ui.dart';

import 'ui/local_screen.dart';
import 'ui/theme.dart';
import 'ui/youtube_screen.dart';

void main() {
  runApp(const ProviderScope(child: MenduApp()));
}

class MenduApp extends StatelessWidget {
  const MenduApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mendu',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      home: const HomeScreen(),
    );
  }
}

/// Phase 1: two tabs, one per kind of player. Rooms and sync come in Phase 2.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Mendu'),
          backgroundColor: AppColors.background,
          bottom: const TabBar(
            tabs: [
              Tab(icon: Icon(Icons.smart_display_outlined), text: 'YouTube'),
              Tab(icon: Icon(Icons.movie_outlined), text: 'Local file'),
            ],
          ),
        ),
        // Both tabs stay alive so switching doesn't stop a player.
        body: const TabBarView(
          physics: NeverScrollableScrollPhysics(),
          children: [_KeepAlive(child: YouTubeScreen()), _KeepAlive(child: LocalScreen())],
        ),
      ),
    );
  }
}

class _KeepAlive extends StatefulWidget {
  const _KeepAlive({required this.child});
  final Widget child;

  @override
  State<_KeepAlive> createState() => _KeepAliveState();
}

class _KeepAliveState extends State<_KeepAlive> with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => true;

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return widget.child;
  }
}
