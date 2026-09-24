import AppKit
import ClaudeUsageCore
import SwiftUI

// MARK: - Views

private struct ProgressBar: View {
    let percent: Int
    let color: Color
    /// Where the window's own clock stands, 0...100. A tick here says how much
    /// of the quota the elapsed time has already earned; fill past it is usage
    /// running ahead of its window.
    var elapsedPercent: Int?
    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(color)
                    .frame(width: max(0, geo.size.width * CGFloat(percent) / 100))
                if let elapsedPercent {
                    Rectangle().fill(Color.primary.opacity(0.55))
                        .frame(width: 2, height: 12)
                        .offset(x: max(0, geo.size.width * CGFloat(elapsedPercent) / 100 - 1))
                }
            }
        }
        .frame(height: 8)
    }
}

private struct CardView: View {
    let card: LimitCard
    let spark: String
    let forecast: Forecast?
    /// Week-over-week peak - the one thing the 6-hour forecast cannot say.
    let trend: WeekOverWeek?
    var body: some View {
        let color = Color.severity(card.severity)
        let pace = UsageClock.pace(card)
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(card.label).font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.primary.opacity(0.85))
                if card.active { Circle().fill(color).frame(width: 6, height: 6) }
                Spacer()
                Text("\(card.percent)%").font(.system(size: 15, weight: .heavy))
                    .foregroundColor(color).monospacedDigit()
            }
            ProgressBar(percent: card.percent, color: color, elapsedPercent: pace?.elapsedPercent)
            HStack {
                // A per-model card (Fable) caps a share of the weekly pool rather
                // than adding one, so its reset line carries that note - same
                // reset as the all-models card it draws from.
                Text(
                    [
                        ResetCountdown.text(card.resetsAt), UsageNormalizer.poolNote(card),
                        UsageClock.format(pace),
                    ]
                    .filter { !$0.isEmpty }.joined(separator: " · ")
                ).font(.system(size: 11))
                    .foregroundColor(.secondary)
                Spacer()
                if !spark.isEmpty {
                    Text(spark).font(.system(size: 11, design: .monospaced))
                        .foregroundColor(.secondary)
                }
            }
            // Burn-rate projection: amber when the limit runs out before its
            // reset, quiet when the pace outlasts it, absent when idle.
            if let fc = forecast {
                Text(UsageForecast.format(fc)).font(.system(size: 11))
                    .foregroundColor(fc.exhaustsBeforeReset ? .cuWarning : .secondary)
            }
            if let trend {
                Text(Warehouse.format(trend)).font(.system(size: 11))
                    .foregroundColor(.secondary)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.05)))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(
                    card.severity == .critical ? color.opacity(0.35) : Color.primary.opacity(0.08)))
    }
}

struct PopupView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Title, plan, then the controls as icons - the GNOME header's
            // layout: auto-switch (only with something to switch between),
            // refresh, settings, and quit as the cross in the corner.
            HStack(alignment: .center, spacing: 4) {
                Text("Claude usage").font(.system(size: 15, weight: .bold))
                Spacer()
                if let plan = model.planLabel, !plan.isEmpty {
                    Text(plan).font(.system(size: 12, weight: .semibold)).foregroundColor(
                        .secondary)
                }
                if model.accountsEnabled && model.accounts.count >= 2
                    && model.showAutoSwitchInMenu
                {
                    // No text of its own, so the hover title says which way it is set.
                    HeaderIcon(
                        systemImage: "person.2.circle",
                        title: "Auto-switch at \(model.accountsSwitchThreshold)% · "
                            + (model.accountsAutoSwitch ? "on" : "off"),
                        lit: model.accountsAutoSwitch
                    ) { model.accountsAutoSwitch.toggle() }
                }
                // Reopen the newest session snapshot as tabs. Shown only when
                // there is one, exactly as on GNOME.
                if model.saved.canReopen {
                    HeaderIcon(
                        systemImage: "clock.arrow.circlepath",
                        title: "Reopen \(model.saved.newestLine)"
                    ) { model.saved.reopen() }
                }
                HeaderIcon(systemImage: "arrow.clockwise", title: "Refresh now") {
                    Task { await model.refresh() }
                }
                SettingsIcon()
                HeaderIcon(systemImage: "xmark", title: "Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }

            if let err = model.errorText, model.cards.isEmpty {
                Text(err).font(.system(size: 12)).foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(model.cards) {
                    CardView(
                        card: $0,
                        spark: Sparkline.render(Sparkline.percents(model.history[$0.id] ?? [])),
                        forecast: model.forecasts[$0.id], trend: model.trends[$0.id])
                }
                // The cards are the last good reading; this is why they are.
                if let err = model.errorText {
                    Text(err).font(.system(size: 11)).foregroundColor(.cuWarning)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            // Prepaid credit already charged this cycle. Absent entirely when
            // the account has extra usage off - a disabled cap is not headroom.
            if let extra = model.extraUsage {
                HStack(spacing: 4) {
                    Text("Extra usage").font(.system(size: 12, weight: .semibold))
                    Text(
                        extra.limitAmount != nil
                            ? "\(extra.detail) (\(extra.percent)% of the cap)" : extra.detail
                    )
                    .font(.system(size: 12))
                    .foregroundColor(
                        extra.severity == .normal ? .secondary : Color.severity(extra.severity))
                    Spacer()
                }
            }

            if let cost = model.costText {
                HStack(spacing: 4) {
                    Text("Session cost: \(cost)").font(.system(size: 12, weight: .semibold))
                    // Cost is reconstructed from local logs and a price table,
                    // unlike the limit percentages above, which are read from
                    // the account's usage endpoint. Say which is which.
                    Text(Provenances.cost.badge)
                        .font(.system(size: 9))
                        .foregroundColor(.secondary)
                        .help(Provenances.cost.explanation)
                }
            }
            Text("Updated \(model.updated) · limits \(Provenances.limits.badge)")
                .font(.system(size: 11)).foregroundColor(.secondary)
                .help(Provenances.limits.explanation)
            if model.sessionPing.enabled || !model.sessionPing.lastPing.isEmpty {
                Text("Session pings: \(model.sessionPing.statusLine)")
                    .font(.system(size: 11)).foregroundColor(.secondary)
            }
            if let u = model.updates.status, u.needsAttention {
                Text(u.summary).font(.system(size: 11)).foregroundColor(.cuCritical)
            }

            if model.showSessions && !model.sessions.isEmpty {
                SessionsSectionView(model: model)
            }

            if model.cursorEnabled {
                CursorSectionView(model: model)
            }

            if model.accountsEnabled && !model.accounts.isEmpty {
                AccountsSectionView(model: model)
            }

            Divider()

            HStack {
                Toggle("Cost", isOn: $model.showCost).toggleStyle(.checkbox).font(.system(size: 12))
                Toggle("Alerts", isOn: $model.alertsEnabled).toggleStyle(.checkbox).font(
                    .system(size: 12))
                Spacer()
                Text("Refresh").font(.system(size: 12)).foregroundColor(.secondary)
                Picker("", selection: $model.refreshMinutes) {
                    ForEach([1, 5, 10, 15, 30, 60], id: \.self) { Text("\($0)m").tag($0) }
                }.labelsHidden().frame(width: 70)
            }
        }
        .padding(14)
        .frame(width: 340)
        .onAppear {
            model.sessionPing.reload()
            model.saved.reload()
        }
    }
}

// One header control: an icon, its hover title (which is also its accessible
// name - the icon alone says little), lit when the setting it shows is on.
private struct HeaderIcon: View {
    let systemImage: String
    let title: String
    var lit = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 13, weight: .medium))
                .foregroundColor(lit ? .accentColor : .secondary)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help(title)
        .accessibilityLabel(title)
    }
}

// The settings icon. An .accessory (menu-bar only) app is not active when the
// popup is clicked, so without an explicit activate the window opens behind
// everything and looks like it never appeared.
private struct SettingsIcon: View {
    var body: some View {
        if #available(macOS 14.0, *) {
            SettingsIcon14()
        } else {
            HeaderIcon(systemImage: "gearshape", title: "Settings") {
                NSApp.activate(ignoringOtherApps: true)
                // Renamed across versions; try both.
                if !NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil) {
                    NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
                }
            }
        }
    }
}

// macOS 14+: SettingsLink alone does not activate the app either; the
// openSettings environment action plus an explicit activate does.
@available(macOS 14.0, *)
private struct SettingsIcon14: View {
    @Environment(\.openSettings) private var openSettings
    var body: some View {
        HeaderIcon(systemImage: "gearshape", title: "Settings") {
            NSApp.activate(ignoringOtherApps: true)
            openSettings()
        }
    }
}

// Today's sessions in the dropdown: biggest token spender first, one click to
// resume it where it was left. Tokens are reconstructed from the local
// transcripts, so the header says "est." for the same reason the cost line does.
private struct SessionsSectionView: View {
    @ObservedObject var model: UsageModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(
                model.sessionsPending
                    ? "Today's sessions (est., still indexing)" : "Today's sessions (est.)"
            )
            .font(.system(size: 13, weight: .bold))
            ForEach(model.sessions) { session in
                Button {
                    model.resume(session)
                } label: {
                    HStack {
                        // The glyph marks the row as an action - a hover
                        // highlight alone is invisible until you are on it.
                        Text("\u{25b8} \(session.label)")
                            .font(.system(size: 12, weight: .semibold))
                        Spacer()
                        Text(
                            "\(SessionFormat.compactTokens(session.tokens))  \(session.when)"
                        )
                        .font(.system(size: 11)).foregroundColor(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .help("Resume in a terminal: \(session.cwd)")
            }
            if let err = model.sessionError {
                Text(err).font(.system(size: 11)).foregroundColor(.cuCritical)
            }
        }
    }
}

// Cursor spend block in the dropdown (shown when enabled).
private struct CursorSectionView: View {
    @ObservedObject var model: UsageModel
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Cursor").font(.system(size: 13, weight: .bold))
            if let s = model.cursorSummary {
                if let pct = s.percent {
                    Text(
                        String(
                            format: "This cycle: $%.2f / $%.0f (%d%%) · %d members",
                            s.cycleUSD, s.limitUSD, pct, s.members)
                    ).font(.system(size: 12, weight: .semibold))
                    ProgressBar(
                        percent: pct,
                        color: pct >= 100 ? .cuCritical : (pct >= 90 ? .cuWarning : .cuAccent))
                } else {
                    Text(String(format: "This cycle: $%.2f · %d members", s.cycleUSD, s.members))
                        .font(.system(size: 12, weight: .semibold))
                }
                if let today = s.todayUSD {
                    Text(String(format: "Today: $%.2f", today))
                        .font(.system(size: 11)).foregroundColor(.secondary)
                }
                if let top = s.top {
                    Text(String(format: "Top: %@ $%.2f", top.email, top.usd))
                        .font(.system(size: 11)).foregroundColor(.secondary)
                }
            } else if let err = model.cursorError {
                Text("Cursor: \(err)").font(.system(size: 12)).foregroundColor(.secondary)
            } else {
                Text("Loading…").font(.system(size: 12)).foregroundColor(.secondary)
            }
        }
    }
}
