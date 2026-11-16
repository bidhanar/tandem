#ifndef RUNNER_YOUTUBE_VIEW_H_
#define RUNNER_YOUTUBE_VIEW_H_

#include <flutter_linux/flutter_linux.h>
#include <gtk/gtk.h>

// Lets the Dart side show one WebKitGTK web view on top of the Flutter view,
// for the YouTube player. Flutter has no web view widget on Linux, so the
// window holds a GtkOverlay: the Flutter view fills it and the web view is
// placed over it, at the rectangle Dart asks for.
//
// Dart talks to it on the "mendu/youtube_view" method channel:
//   create(url)              make the web view and load the page
//   setFrame([x, y, w, h])   move/resize it (logical pixels); w = 0 hides it
//   eval(script)             run JavaScript in the page
//   dispose()                remove it
// and receives:
//   message(text)            whatever the page posted to
//                            window.webkit.messageHandlers.mendu
void youtube_view_register(FlView* view, GtkOverlay* overlay);

#endif  // RUNNER_YOUTUBE_VIEW_H_
