#include "my_application.h"

#include <glib.h>
#include <stdlib.h>

int main(int argc, char** argv) {
  // WebKitGTK (the YouTube player) aborts at startup with its default
  // renderer on NVIDIA's proprietary driver. Its fallback renderer works.
  if (g_file_test("/sys/module/nvidia", G_FILE_TEST_EXISTS)) {
    setenv("WEBKIT_DISABLE_DMABUF_RENDERER", "1", /*overwrite=*/0);
  }

  g_autoptr(MyApplication) app = my_application_new();
  return g_application_run(G_APPLICATION(app), argc, argv);
}
