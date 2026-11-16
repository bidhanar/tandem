/// Pulls the video ID out of a YouTube link.
///
/// Accepts watch, youtu.be, shorts, embed and live links, with or without
/// extra parameters (&t=, &list=, &si=), and a bare 11-character ID.
/// Returns null when the text isn't a YouTube video link.
String? parseYouTubeVideoId(String input) {
  final text = input.trim();
  if (_idPattern.hasMatch(text)) return text;

  final uri = Uri.tryParse(text.contains('://') ? text : 'https://$text');
  if (uri == null) return null;

  final host = uri.host.toLowerCase().replaceFirst(RegExp(r'^(www|m)\.'), '');
  final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();

  String? id;
  if (host == 'youtu.be') {
    id = segments.isEmpty ? null : segments.first;
  } else if (host == 'youtube.com' || host == 'youtube-nocookie.com') {
    if (segments.isNotEmpty && segments.first == 'watch') {
      id = uri.queryParameters['v'];
    } else if (segments.length >= 2 && _pathPrefixes.contains(segments.first)) {
      id = segments[1];
    }
  }
  return id != null && _idPattern.hasMatch(id) ? id : null;
}

final _idPattern = RegExp(r'^[A-Za-z0-9_-]{11}$');
const _pathPrefixes = {'shorts', 'embed', 'live', 'v'};
