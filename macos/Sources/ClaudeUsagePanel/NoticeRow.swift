import ClaudeUsageCore
import SwiftUI

// One inline row that says something is wrong and carries the single thing
// that fixes it. Deliberately IN the list it is about - an accounts problem
// reported at the bottom of the popup, or in Settings, is a problem nobody
// reads. The GNOME extension draws the same row from the same contract
// (lib/noticeRow.js over lib/pure/notices.js).

/// The body of a notice: a severity dot, a sentence, one button.
struct NoticeRow: View {
    let severity: Severity
    let text: String
    /// The single repair. Nil for a notice that is only telling you something.
    var actionLabel: String?
    var action: (() -> Void)?
    /// What pressing it did, shown right here rather than in a global line.
    var outcome: ControlOutcome?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\u{25cf}")
                    .font(.system(size: 9))
                    .foregroundColor(Color.severity(severity))
                Text(text)
                    .font(.system(size: 11))
                    .foregroundColor(.primary.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 6)
                if let actionLabel, let action {
                    Button(actionLabel, action: action)
                        .buttonStyle(.borderless)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.cuAccent)
                }
            }
            if let outcome {
                OutcomeText(outcome)
            }
        }
        .padding(.vertical, 3)
        .padding(.horizontal, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.severity(severity).opacity(0.10)))
    }
}

/// The answer to the last action, beside the control that caused it. It clears
/// itself (ControlOutcome.ttlMs) and on the next action, so it can never
/// become furniture or describe something two actions old.
struct OutcomeText: View {
    private let outcome: ControlOutcome
    init(_ outcome: ControlOutcome) { self.outcome = outcome }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: outcome.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .font(.system(size: 9))
            Text(outcome.text)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.system(size: 10))
        .foregroundColor(outcome.ok ? .cuAccent : .cuCritical)
        .accessibilityLabel(
            (outcome.ok ? "Succeeded: " : "Failed: ") + outcome.text)
    }
}
