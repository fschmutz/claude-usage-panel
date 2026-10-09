import SwiftUI

/// A dropdown section that folds to its header. The session lists (Waiting
/// on you, Pause sessions, Today's sessions) grow one row per session and the
/// popup has no scroll bar, so with a dozen tabs open they pushed everything
/// below them off the screen. Folded by default: the header keeps the title,
/// the row count and the section's own buttons, and the choice is remembered
/// per section (UserDefaults `popupExpanded.<key>`).
struct CollapsibleSection<Header: View, Content: View>: View {
    private let title: String
    private let count: Int
    private let titleColor: Color
    private let header: () -> Header
    private let content: () -> Content
    @AppStorage private var expanded: Bool

    init(
        _ key: String, title: String, count: Int, titleColor: Color = .primary,
        @ViewBuilder header: @escaping () -> Header,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.count = count
        self.titleColor = titleColor
        self.header = header
        self.content = content
        _expanded = AppStorage(wrappedValue: false, "popupExpanded.\(key)")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Button {
                    expanded.toggle()
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(.secondary)
                            .frame(width: 10)
                        Text(title)
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(titleColor)
                        Text("\(count)")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .help(expanded ? "Fold this section" : "Show its \(count) rows")
                Spacer()
                header()
            }
            if expanded {
                content()
            }
        }
    }
}

extension CollapsibleSection where Header == EmptyView {
    init(
        _ key: String, title: String, count: Int, titleColor: Color = .primary,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(
            key, title: title, count: count, titleColor: titleColor, header: { EmptyView() },
            content: content)
    }
}
