import SwiftUI

/// The amber strip under the dropdown's header while the scheduled autosave
/// is paused (`claudectl session autosave pause`): the newest snapshot is
/// frozen until the next boot, which is easy to forget. The GNOME twin is
/// lib/autosaveBanner.js; the menu-bar gauge carries a pause mark too.
struct AutosavePauseBanner: View {
    @ObservedObject var saved: SavedSessions

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f
    }()

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 18))
                .foregroundColor(.cuWarning)
            VStack(alignment: .leading, spacing: 1) {
                Text("Autosave paused").font(.system(size: 12, weight: .semibold))
                Text(detail).font(.system(size: 11)).foregroundColor(.secondary)
            }
            Spacer()
            Button("Resume") { saved.setPaused(false) }
                .controlSize(.small)
                .disabled(!saved.canSave)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8).fill(Color.cuWarning.opacity(0.16))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8).strokeBorder(
                Color.cuWarning.opacity(0.6), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    private var detail: String {
        let since = saved.pausedSince.map { "since \(Self.clock.string(from: $0)), " } ?? ""
        return "\(since)until restart - Reopen keeps the newest snapshot"
    }
}
