import AppKit
import ClaudeUsageCore
import Combine
import SwiftUI

// The "Storage" tab of Settings: what the known dev caches cost, and one
// button that moves the chosen ones to the Trash.
//
// Its own tab on purpose. This is the only thing in the app that removes
// anything, and it does not belong a click away from the usage popup where a
// mis-aim costs somebody their transcripts. It is READ-ONLY until Reclaim is
// pressed: opening the tab measures and nothing else.
//
// Everything it moves goes through FileManager.trashItem - the Trash, with
// Finder's own Put Back as the undo. There is no unlink in this file.

@MainActor
final class ReclaimModel: ObservableObject {
    @Published private(set) var entries: [ReclaimEntry] = []
    @Published private(set) var scanning = false
    /// Ticked by the user. Starts as the regenerated caches; history is never
    /// pre-selected, and the checkbox for one carries its own warning.
    @Published var chosen: Set<String> = Set(Reclaim.defaultIds)
    @Published private(set) var lastRun: String?
    @Published private(set) var error: String?

    private static var dirs: Reclaim.Dirs {
        let env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return Reclaim.Dirs(
            home: home,
            claudeHome: env["CLAUDE_CONFIG_DIR"].flatMap { $0.isEmpty ? nil : $0 }
                ?? "\(home)/.claude",
            codexHome: env["CODEX_HOME"].flatMap { $0.isEmpty ? nil : $0 } ?? "\(home)/.codex",
            xdgCache: "\(home)/.cache", xdgConfig: "\(home)/.config")
    }

    var plan: ReclaimPlan {
        Reclaim.plan(scanned: entries, ids: Array(chosen), includeHistory: true)
    }

    /// Measure. Off the main actor: a cold transcript directory is tens of
    /// thousands of files, and this must never block the Settings window.
    func scan() async {
        guard !scanning else { return }
        scanning = true
        defer { scanning = false }
        let catalog = Reclaim.entries(dirs: Self.dirs, platform: "darwin")
        entries = await Task.detached(priority: .utility) {
            catalog.map { entry in
                var sized = entry
                sized.bytes = Self.sizeOf(entry.path)
                return sized
            }
        }.value
    }

    /// Recursive size, or nil when the path is not there. Symlinks count as
    /// their own size and are never followed, so a link into somewhere huge
    /// cannot make a cache look enormous - or be moved as one.
    nonisolated private static func sizeOf(_ path: String) -> Int? {
        let fm = FileManager.default
        guard let attrs = try? fm.attributesOfItem(atPath: path) else { return nil }
        let type = attrs[.type] as? FileAttributeType
        if type == .typeSymbolicLink { return (attrs[.size] as? NSNumber)?.intValue ?? 0 }
        if type != .typeDirectory { return (attrs[.size] as? NSNumber)?.intValue ?? 0 }
        var total = 0
        guard let walker = fm.enumerator(atPath: path) else { return total }
        for case let name as String in walker {
            let child = (path as NSString).appendingPathComponent(name)
            guard let childAttrs = try? fm.attributesOfItem(atPath: child) else { continue }
            if (childAttrs[.type] as? FileAttributeType) == .typeSymbolicLink {
                walker.skipDescendants()
            }
            total += (childAttrs[.size] as? NSNumber)?.intValue ?? 0
        }
        return total
    }

    /// Move the ticked entries to the Trash. Called only from the confirmation
    /// sheet's Reclaim button - never from a toggle, never from onAppear.
    func reclaim() {
        let targets = plan.targets
        var moved = 0
        var freed = 0
        var failures: [String] = []
        for entry in targets {
            do {
                // Trash, not delete: Finder knows how to put this back.
                try FileManager.default.trashItem(
                    at: URL(fileURLWithPath: entry.path), resultingItemURL: nil)
                moved += 1
                freed += entry.bytes ?? 0
            } catch {
                // One unwritable cache must not stop the rest.
                failures.append("\(entry.id): \(error.localizedDescription)")
            }
        }
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
        lastRun =
            moved == 0
            ? nil
            : "Moved \(moved) to the Trash - \(Reclaim.formatBytes(freed)). "
                + "Finder ▸ Put Back undoes it."
        Task { await scan() }
    }
}

struct ReclaimSettingsSection: View {
    @StateObject private var model = ReclaimModel()
    @State private var confirming = false

    var body: some View {
        Section("Storage") {
            Text(
                "What the local Claude Code, Cursor and Codex caches are costing. Opening this "
                    + "tab only measures - nothing is touched until you press Reclaim, and what "
                    + "is reclaimed goes to the Trash, not away."
            )
            .font(.footnote).foregroundColor(.secondary)
            if model.scanning && model.entries.isEmpty {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("Measuring…").font(.footnote).foregroundColor(.secondary)
                }
            }
            ForEach(model.entries.filter(\.exists)) { entry in
                row(entry)
            }
            if !model.scanning && model.entries.allSatisfy({ !$0.exists }) {
                Text("None of the known caches exist on this Mac.")
                    .font(.footnote).foregroundColor(.secondary)
            }
        }
        Section {
            HStack {
                Text(
                    model.plan.targets.isEmpty
                        ? "Nothing selected"
                        : "\(model.plan.targets.count) selected · "
                            + Reclaim.formatBytes(model.plan.totalBytes)
                )
                .font(.system(size: 12, weight: .semibold))
                Spacer()
                Button("Rescan") { Task { await model.scan() } }.disabled(model.scanning)
                Button("Reclaim…") { confirming = true }
                    .disabled(model.plan.targets.isEmpty || model.scanning)
            }
            if let last = model.lastRun {
                Text(last).font(.footnote).foregroundColor(.cuAccent)
            }
            if let err = model.error {
                Text(err).font(.footnote).foregroundColor(.cuCritical)
            }
            Text(
                "`claudectl cache list` prints the same table in a terminal, and "
                    + "`claudectl cache log` says what past runs moved and where it went."
            )
            .font(.footnote).foregroundColor(.secondary)
        }
        .confirmationDialog(
            "Move \(model.plan.targets.count) item(s) to the Trash?",
            isPresented: $confirming, titleVisibility: .visible
        ) {
            Button("Move to Trash", role: .destructive) { model.reclaim() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                model.plan.targets.map { "\($0.tool) · \($0.label) (\($0.human))" }
                    .joined(separator: "\n")
                    + "\n\nTotal \(Reclaim.formatBytes(model.plan.totalBytes)). "
                    + "They go to the Trash; Finder ▸ Put Back undoes it.")
        }
        .task { await model.scan() }
    }

    private func row(_ entry: ReclaimEntry) -> some View {
        Toggle(
            isOn: Binding(
                get: { model.chosen.contains(entry.id) },
                set: { on in
                    if on {
                        model.chosen.insert(entry.id)
                    } else {
                        model.chosen.remove(entry.id)
                    }
                })
        ) {
            VStack(alignment: .leading, spacing: 1) {
                HStack {
                    Text("\(entry.tool) · \(entry.label)")
                    if entry.kind == .history {
                        Text("history")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.cuCritical)
                    }
                    Spacer()
                    Text(entry.human).monospacedDigit().foregroundColor(.secondary)
                }
                Text(entry.note)
                    .font(.footnote)
                    .foregroundColor(entry.kind == .history ? .cuWarning : .secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}
