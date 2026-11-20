import AppKit
import ClaudeUsageCore

/// The menu bar's gauge: the logo's 270-degree arc, drawn live - filled to
/// the panel card's honest reading and tinted by its tone. What to draw is
/// `PanelGauge` (ClaudeUsageCore, pinned by tests/fixtures/gauge.json); this
/// is only the AppKit. The GNOME twin is lib/panelGauge.js.
enum MenuBarGauge {
    private static let size = NSSize(width: 18, height: 18)
    private static let stroke: CGFloat = 3
    // AppKit angles run counter-clockwise from 3 o'clock: the arc opens at
    // the bottom, from 225 degrees clockwise through the top to -45.
    private static let start: CGFloat = 225
    private static let sweep: CGFloat = 270

    /// `paused`: the scheduled autosave is paused - two amber bars in the
    /// arc's opening, so it shows without opening the dropdown.
    static func image(_ gauge: PanelGauge, paused: Bool = false) -> NSImage {
        // A drawing handler runs at draw time, so `labelColor` resolves against
        // the menu bar's current appearance (light or dark) every time.
        NSImage(size: size, flipped: false) { rect in
            let r = min(rect.width, rect.height) / 2 - stroke / 2
            // The opening at the bottom makes a centered arc look high; sit
            // it a little lower so the shape itself is centered.
            let center = NSPoint(x: rect.midX, y: rect.midY - r * 0.15)
            let track = arc(center: center, radius: r, fraction: 1)
            NSColor.labelColor.withAlphaComponent(0.3).setStroke()
            track.stroke()
            if gauge.fraction > 0 {
                color(gauge.tone).setStroke()
                arc(center: center, radius: r, fraction: CGFloat(gauge.fraction)).stroke()
            }
            if paused { pauseMark(in: rect) }
            return true
        }
    }

    // Two short bars at the bottom center, where the arc opens.
    private static func pauseMark(in rect: NSRect) {
        color(.warning).setFill()
        let w: CGFloat = 2
        let h: CGFloat = 6
        let gap: CGFloat = 2
        for x in [rect.midX - gap / 2 - w, rect.midX + gap / 2] {
            NSBezierPath(
                roundedRect: NSRect(x: x, y: rect.minY, width: w, height: h), xRadius: 1, yRadius: 1
            )
            .fill()
        }
    }

    private static func arc(center: NSPoint, radius: CGFloat, fraction: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        path.lineWidth = stroke
        path.lineCapStyle = .round
        path.appendArc(
            withCenter: center, radius: radius, startAngle: start,
            endAngle: start - sweep * fraction, clockwise: true)
        return path
    }

    private static func color(_ tone: PanelGauge.Tone) -> NSColor {
        let hex = PanelGauge.colors[tone] ?? PanelGauge.colors[.normal]!
        var value: UInt64 = 0
        Scanner(string: String(hex.dropFirst())).scanHexInt64(&value)
        return NSColor(
            red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
            blue: CGFloat(value & 0xff) / 255, alpha: 1)
    }
}
