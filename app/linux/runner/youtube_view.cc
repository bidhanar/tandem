#include "youtube_view.h"

#include <webkit2/webkit2.h>

namespace {

struct YouTubeView {
  GtkOverlay* overlay = nullptr;
  FlMethodChannel* channel = nullptr;
  GtkWidget* web_view = nullptr;  // null until "create"
};

// The page posted a message: pass it on to Dart.
void on_page_message(WebKitUserContentManager*, WebKitJavascriptResult* result,
                     gpointer user_data) {
  auto* self = static_cast<YouTubeView*>(user_data);
  g_autofree char* text =
      jsc_value_to_string(webkit_javascript_result_get_js_value(result));
  g_autoptr(FlValue) argument = fl_value_new_string(text);
  fl_method_channel_invoke_method(self->channel, "message", argument, nullptr,
                                  nullptr, nullptr);
}

void destroy_web_view(YouTubeView* self) {
  if (self->web_view == nullptr) return;
  gtk_widget_destroy(self->web_view);
  self->web_view = nullptr;
}

void create_web_view(YouTubeView* self, const char* url) {
  destroy_web_view(self);

  WebKitUserContentManager* content = webkit_user_content_manager_new();
  g_signal_connect(content, "script-message-received::mendu",
                   G_CALLBACK(on_page_message), self);
  webkit_user_content_manager_register_script_message_handler(content, "mendu");

  // A play command from the partner must start the video without a click here.
  g_autoptr(WebKitWebsitePolicies) policies =
      webkit_website_policies_new_with_policies(
          "autoplay", WEBKIT_AUTOPLAY_ALLOW, nullptr);

  self->web_view = GTK_WIDGET(g_object_new(
      WEBKIT_TYPE_WEB_VIEW, "user-content-manager", content,
      "website-policies", policies, nullptr));
  g_object_unref(content);

  WebKitWebView* web_view = WEBKIT_WEB_VIEW(self->web_view);
  webkit_settings_set_media_playback_requires_user_gesture(
      webkit_web_view_get_settings(web_view), FALSE);

  // Keep cookies between runs, so a YouTube sign-in is remembered.
  g_autofree char* data_dir =
      g_build_filename(g_get_user_data_dir(), "mendu", nullptr);
  g_mkdir_with_parents(data_dir, 0700);
  g_autofree char* cookies = g_build_filename(data_dir, "cookies.sqlite", nullptr);
  webkit_cookie_manager_set_persistent_storage(
      webkit_web_context_get_cookie_manager(
          webkit_web_view_get_context(web_view)),
      cookies, WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);

  // Positioned by margins from the overlay's top-left corner; hidden until
  // Dart sends the first frame.
  gtk_widget_set_halign(self->web_view, GTK_ALIGN_START);
  gtk_widget_set_valign(self->web_view, GTK_ALIGN_START);
  gtk_widget_set_no_show_all(self->web_view, TRUE);
  gtk_overlay_add_overlay(self->overlay, self->web_view);

  webkit_web_view_load_uri(web_view, url);
}

void set_frame(YouTubeView* self, FlValue* frame) {
  if (self->web_view == nullptr) return;
  const int x = static_cast<int>(fl_value_get_float(fl_value_get_list_value(frame, 0)));
  const int y = static_cast<int>(fl_value_get_float(fl_value_get_list_value(frame, 1)));
  const int width = static_cast<int>(fl_value_get_float(fl_value_get_list_value(frame, 2)));
  const int height = static_cast<int>(fl_value_get_float(fl_value_get_list_value(frame, 3)));
  if (width <= 0 || height <= 0) {
    gtk_widget_hide(self->web_view);
    return;
  }
  gtk_widget_set_margin_start(self->web_view, x);
  gtk_widget_set_margin_top(self->web_view, y);
  gtk_widget_set_size_request(self->web_view, width, height);
  gtk_widget_show(self->web_view);
}

void on_method_call(FlMethodChannel*, FlMethodCall* call, gpointer user_data) {
  auto* self = static_cast<YouTubeView*>(user_data);
  const gchar* method = fl_method_call_get_name(call);
  FlValue* args = fl_method_call_get_args(call);

  if (g_strcmp0(method, "create") == 0) {
    create_web_view(self, fl_value_get_string(args));
  } else if (g_strcmp0(method, "setFrame") == 0) {
    set_frame(self, args);
  } else if (g_strcmp0(method, "eval") == 0) {
    if (self->web_view != nullptr) {
      webkit_web_view_evaluate_javascript(
          WEBKIT_WEB_VIEW(self->web_view), fl_value_get_string(args), -1,
          nullptr, nullptr, nullptr, nullptr, nullptr);
    }
  } else if (g_strcmp0(method, "dispose") == 0) {
    destroy_web_view(self);
  } else {
    fl_method_call_respond_not_implemented(call, nullptr);
    return;
  }
  fl_method_call_respond_success(call, nullptr, nullptr);
}

}  // namespace

void youtube_view_register(FlView* view, GtkOverlay* overlay) {
  // Lives as long as the window does, so it is never freed.
  auto* self = new YouTubeView();
  self->overlay = overlay;

  g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
  self->channel = fl_method_channel_new(
      fl_engine_get_binary_messenger(fl_view_get_engine(view)),
      "mendu/youtube_view", FL_METHOD_CODEC(codec));
  fl_method_channel_set_method_call_handler(self->channel, on_method_call, self,
                                            nullptr);
}
