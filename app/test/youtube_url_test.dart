import 'package:flutter_test/flutter_test.dart';
import 'package:syncus/youtube/youtube_url.dart';

void main() {
  const id = 'dQw4w9WgXcQ';

  test('accepts every supported link shape', () {
    for (final link in [
      'https://www.youtube.com/watch?v=$id',
      'http://youtube.com/watch?v=$id',
      'youtube.com/watch?v=$id',
      'https://m.youtube.com/watch?v=$id',
      'https://youtu.be/$id',
      'https://youtu.be/$id?si=abcDEF123&t=42',
      'https://www.youtube.com/shorts/$id',
      'https://www.youtube.com/shorts/$id?feature=share',
      'https://www.youtube.com/embed/$id',
      'https://www.youtube.com/live/$id',
      'https://www.youtube.com/watch?list=PL123&v=$id&t=1m30s&si=xyz',
      '  https://www.youtube.com/watch?v=$id  ',
      id,
    ]) {
      expect(parseYouTubeVideoId(link), id, reason: link);
    }
  });

  test('rejects everything else', () {
    for (final link in [
      '',
      'hello',
      'https://www.youtube.com/',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/playlist?list=PL123',
      'https://www.youtube.com/@somechannel',
      'https://vimeo.com/123456789',
      'https://music.youtube.com/watch?v=$id',
      'https://notyoutube.com/watch?v=$id',
    ]) {
      expect(parseYouTubeVideoId(link), isNull, reason: link);
    }
  });
}
