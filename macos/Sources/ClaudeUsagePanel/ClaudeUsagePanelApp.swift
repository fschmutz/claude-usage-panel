import AppKit
import ClaudeUsageCore
import Network
import SwiftUI

// MARK: - Palette (matches the GNOME extension)

extension Color {
    // Claude orange
    static let cuAccent = Color(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x57 / 255)
    static let cuWarning = Color(red: 0xe0 / 255, green: 0xa4 / 255, blue: 0x58 / 255)
    static let cuCritical = Color(red: 0xe5 / 255, green: 0x48 / 255, blue: 0x4d / 255)

    static func severity(_ s: Severity) -> Color {
        switch s {
        case .normal: return .cuAccent
        case .warning: return .cuWarning
        case .critical: return .cuCritical
        }
    }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)  // menu-bar only, no Dock icon
    }
}

@main
struct ClaudeUsagePanelApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = UsageModel()

    var body: some Scene {
        MenuBarExtra {
            PopupView(model: model)
        } label: {
            Text(model.titleText)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}
