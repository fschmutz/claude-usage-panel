# shellcheck shell=bash
# Sourced by install.sh: the GNOME Shell extension target.

install_gnome() {
    info "GNOME extension"
    if ! command -v glib-compile-schemas >/dev/null; then
        skip_fatal "gnome: glib-compile-schemas not found (not a GNOME desktop?)"
        return 0
    fi
    local dest="$HOME/.local/share/gnome-shell/extensions/$UUID"
    act rm -rf "$dest"
    # Sources + compiled schema + translations + the worker scripts the
    # extension runs itself, in the same layout the release zip ships.
    act "$ROOT/scripts/pack-gnome.sh" "$dest"

    # A global kill switch disables ALL user extensions; clear it if set.
    if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
        act gsettings set org.gnome.shell disable-user-extensions false
        ok "cleared global 'disable-user-extensions' switch"
    fi
    if $DRY; then
        echo "  would: enable $UUID (via gnome-extensions, or register for next login)"
    elif gnome-extensions enable "$UUID" 2>/dev/null; then
        ok "enabled via gnome-extensions"
    else
        _gnome_enabled_key add
        ok "registered in enabled-extensions for next login"
    fi
    if $DRY; then
        ok "dry-run: no changes written"
        return 0
    fi
    ok "installed to $dest"
    echo "  Log out and back in (Wayland loads new extensions only at login)."
}

uninstall_gnome() {
    info "GNOME extension"
    if command -v gnome-extensions >/dev/null; then
        act gnome-extensions disable "$UUID" 2>/dev/null || true
    fi
    _gnome_enabled_key remove 2>/dev/null || true
    act rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
    ok "removed"
}

# Add/remove the UUID from org.gnome.shell enabled-extensions. $1 = add|remove.
# A GVariant string list, not JSON - python's literal parser reads it as is.
_gnome_enabled_key() {
    command -v gsettings >/dev/null || return 0
    if $DRY; then
        echo "  would: $1 $UUID in org.gnome.shell enabled-extensions"
        return 0
    fi
    python3 - "$1" "$UUID" <<'PY'
import subprocess, sys, ast
action, uuid = sys.argv[1], sys.argv[2]
key = ["org.gnome.shell", "enabled-extensions"]
cur = subprocess.run(["gsettings", "get", *key], capture_output=True, text=True).stdout.strip()
try:
    items = ast.literal_eval(cur) if cur and cur != "@as []" else []
except (ValueError, SyntaxError):
    items = []
if action == "add" and uuid not in items:
    items.append(uuid)
elif action == "remove" and uuid in items:
    items.remove(uuid)
else:
    sys.exit(0)
subprocess.run(["gsettings", "set", *key,
                "[" + ", ".join("'%s'" % i for i in items) + "]"], check=True)
PY
}
