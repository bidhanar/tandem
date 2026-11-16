import 'package:material_ui/material_ui.dart';

/// Colours shared with Synaxis: near-black surfaces, warm orange accent.
class AppColors {
  static const background = Color(0xFF0C0C0F);
  static const surface = Color(0xFF17171C);
  static const surfaceRaised = Color(0xFF212128);
  static const text = Color(0xFFF5F5F6);
  static const muted = Color(0xFFA7A7B0);
  static const accent = Color(0xFFFF5A36);
  static const accentWarm = Color(0xFFFFB347);
  static const good = Color(0xFF46D39A);
}

ThemeData buildAppTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: AppColors.accent,
    brightness: Brightness.dark,
  ).copyWith(
    primary: AppColors.accent,
    onPrimary: Colors.white,
    surface: AppColors.surface,
    onSurface: AppColors.text,
    onSurfaceVariant: AppColors.muted,
    error: const Color(0xFFFF6B6B),
  );
  return ThemeData(
    colorScheme: scheme,
    scaffoldBackgroundColor: AppColors.background,
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: AppColors.surfaceRaised,
      border: OutlineInputBorder(borderSide: BorderSide.none),
    ),
  );
}
