// Two things that make a poll worth doing right now, whatever the timer says:
// the machine came back from suspend (every countdown on screen is stale by
// however long the lid was shut), and the network came back (the polls during
// the outage all failed).

import Gio from 'gi://Gio';

/**
 * Call `onWake` after a resume from suspend or when the network comes back.
 * @param {() => void} onWake
 * @returns {() => void} stops watching
 */
export function watchWakeAndNetwork(onWake) {
    let logindId = 0;
    try {
        logindId = Gio.DBus.system.signal_subscribe(
            'org.freedesktop.login1',
            'org.freedesktop.login1.Manager',
            'PrepareForSleep',
            '/org/freedesktop/login1',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                // true = about to suspend, false = just resumed.
                if (!params.deepUnpack()[0])
                    onWake();
            });
    } catch (e) {
        logError(e, 'claude-usage-panel: no logind resume signal');
    }
    const owner = {};
    const monitor = Gio.NetworkMonitor.get_default();
    monitor?.connectObject('network-changed', (_m, available) => {
        if (available)
            onWake();
    }, owner);
    return () => {
        if (logindId)
            Gio.DBus.system.signal_unsubscribe(logindId);
        logindId = 0;
        monitor?.disconnectObject(owner);
    };
}
