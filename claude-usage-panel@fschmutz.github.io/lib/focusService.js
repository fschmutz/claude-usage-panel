// RaiseWindow over D-Bus, for `claudectl session focus`: on Wayland only the
// Shell may bring a window to the front, and gnome-terminal has no way to be
// asked for one. The caller names the window the way GTK exports it - the
// application's unique bus name and the window's object path - and the
// Shell activates the one window that matches both, or answers false.
// Exported on the Shell's own connection (dest org.gnome.Shell).

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export const FOCUS_PATH = '/io/github/fschmutz/ClaudeUsagePanel';
const IFACE = `<node>
  <interface name="io.github.fschmutz.ClaudeUsagePanel">
    <method name="RaiseWindow">
      <arg type="s" direction="in" name="busName"/>
      <arg type="s" direction="in" name="windowPath"/>
      <arg type="b" direction="out" name="raised"/>
    </method>
  </interface>
</node>`;

/** The one window whose GTK bus name and object path are these, or null. */
export function findGtkWindow(windows, busName, windowPath) {
    if (!busName || !windowPath)
        return null;
    return windows.find(w => w.get_gtk_unique_bus_name?.() === busName
        && w.get_gtk_window_object_path?.() === windowPath) ?? null;
}

/** Export RaiseWindow; returns the unexport. */
export function exportFocusService() {
    const service = Gio.DBusExportedObject.wrapJSObject(IFACE, {
        RaiseWindow(busName, windowPath) {
            const windows = global.get_window_actors().map(a => a.meta_window);
            const win = findGtkWindow(windows, busName, windowPath);
            if (win)
                Main.activateWindow(win);
            return Boolean(win);
        },
    });
    service.export(Gio.DBus.session, FOCUS_PATH);
    return () => service.unexport();
}
