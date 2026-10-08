import XCTest

@testable import ClaudeUsageCore

/// Cross-port parity for session pause / resume: the Swift core is asserted
/// against the very same fixture the JS port uses (tests/pause.test.js).
final class PauseParityTests: XCTestCase {
    private func fixture() throws -> [String: Any] { try Fixtures.load("pause.json") }

    private func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber else { return nil }
        return n.doubleValue
    }

    func testConstants() throws {
        let fix = try fixture()
        XCTAssertEqual(Pause.version, (fix["version"] as! NSNumber).intValue)
        XCTAssertEqual(Pause.kinds, fix["kinds"] as! [String])
        XCTAssertEqual(Pause.verdicts, fix["verdicts"] as! [String])
        XCTAssertEqual(Pause.sources, fix["sources"] as! [String])
        XCTAssertEqual(Pause.vias, fix["vias"] as! [String])
        XCTAssertEqual(Pause.requestTtlMs, num(fix["requestTtlMs"]))
    }

    func testIsSessionId() throws {
        for c in try fixture()["isSessionId"] as! [[String: Any]] {
            XCTAssertEqual(Pause.isSessionId(c["id"]), c["expected"] as? Bool, "\(c["id"]!)")
        }
        // The JS regex has no m flag: a trailing newline is not an id.
        XCTAssertFalse(Pause.isSessionId("abc\n"))
        XCTAssertFalse(Pause.isSessionId("\u{e9}t\u{e9}"))
    }

    func testParseRequest() throws {
        for (i, c) in (try fixture()["parseRequest"] as! [[String: Any]]).enumerated() {
            let got = Pause.parseRequest(c["raw"])
            guard let e = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, "case \(i)")
                continue
            }
            let r = try XCTUnwrap(got, "case \(i)")
            XCTAssertEqual(r.version, (e["version"] as! NSNumber).intValue)
            XCTAssertEqual(r.id, e["id"] as? String)
            XCTAssertEqual(r.kind.rawValue, e["kind"] as? String)
            XCTAssertEqual(r.at, num(e["at"]))
            XCTAssertEqual(r.from.rawValue, e["from"] as? String)
            XCTAssertEqual(r.origin, e["origin"] as? String, "case \(i)")
            if e["targets"] as? String == "all" {
                XCTAssertEqual(r.targets, .all, "case \(i)")
            } else {
                XCTAssertEqual(r.targets, .sessions(e["targets"] as! [String]), "case \(i)")
            }
            // pid / procStart bind a request to a process: delivery side, Node-only
            let sessions = (e["sessions"] as! [[String: Any]]).map {
                PauseSessionMeta(
                    sessionId: $0["sessionId"] as! String, name: $0["name"] as! String,
                    cwd: $0["cwd"] as! String)
            }
            XCTAssertEqual(r.sessions, sessions, "case \(i)")
        }
    }

    func testClean() throws {
        for (i, c) in (try fixture()["clean"] as! [[String: Any]]).enumerated() {
            let max = (c["max"] as! NSNumber).intValue
            XCTAssertEqual(
                Pause.cleanText(c["text"], max: max), c["expected"] as? String, "case \(i)")
        }
        XCTAssertEqual(Pause.reasonMax, (try fixture()["reasonMax"] as! NSNumber).intValue)
    }

    func testRowName() throws {
        for (i, c) in (try fixture()["rowName"] as! [[String: Any]]).enumerated() {
            let live = c["live"] as? [String: Any]
            let meta = c["meta"] as? [String: Any]
            XCTAssertEqual(
                Pause.rowName(
                    c["sessionId"] as! String, name: live?["name"], cwd: live?["cwd"],
                    metaName: meta?["name"], metaCwd: meta?["cwd"]),
                c["expected"] as? String, "case \(i)")
        }
    }

    func testSummary() throws {
        for c in try fixture()["summary"] as! [[String: Any]] {
            let kind = PauseKind(rawValue: c["kind"] as! String)!
            let states = c["states"] as! [String]
            let e = c["expected"] as! [String: Any]
            let got = Pause.summary(states: states, kind: kind)
            let name = "\(kind) \(states)"
            XCTAssertEqual(got.total, (e["total"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.delivered, (e["delivered"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.safe, (e["safe"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.notSafe, (e["notSafe"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.resumed, (e["resumed"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.pending, (e["pending"] as! NSNumber).intValue, name)
            XCTAssertEqual(got.done, e["done"] as? Bool, name)
            XCTAssertEqual(got.ok, e["ok"] as? Bool, name)
            XCTAssertEqual(got.label, e["label"] as? String, name)
        }
    }

    func testEveryStateHasALabel() {
        for state in PauseRowState.allCases {
            XCTAssertGreaterThan(Pause.rowLabel(PauseRow(state: state, via: .rewake)).count, 2)
        }
        XCTAssertEqual(
            Pause.rowLabel(PauseRow(state: .notSafe, reason: "CI 4")), "NOT SAFE: CI 4")
        XCTAssertEqual(Pause.rowLabel(PauseRow(state: .expired)), "expired before delivery")
        XCTAssertEqual(
            Pause.rowLabel(PauseRow(state: .expired, via: .rewake)), "no verdict within the hour")
    }

    /// The real `pause-status --json` shape (pinned against the Node producer
    /// by tests/pause.test.js) read back into the panel rows.
    func testStatusFixture() throws {
        let st = try fixture()["status"] as! [String: Any]
        let status = try XCTUnwrap(Pause.parseStatus(st["json"]))
        XCTAssertEqual(status.summary.label, st["summaryLabel"] as? String)
        XCTAssertEqual(status.summary.done, st["summaryDone"] as? Bool)
        let live = (st["live"] as! [[String: Any]]).map {
            Waiting.LiveSession(
                pid: ($0["pid"] as! NSNumber).intValue, sessionId: $0["sessionId"] as! String,
                name: $0["name"] as! String, cwd: $0["cwd"] as! String)
        }
        let rows = Pause.panelRows(status: status, live: live)
        let expected = st["panel"] as! [[String: Any]]
        XCTAssertEqual(rows.count, expected.count)
        for (got, e) in zip(rows, expected) {
            XCTAssertEqual(got.sessionId, e["sessionId"] as? String)
            XCTAssertEqual(got.name, e["name"] as? String, got.sessionId)
            XCTAssertEqual(got.cwd, e["cwd"] as? String, got.sessionId)
            XCTAssertEqual(got.live, e["live"] as? Bool, got.sessionId)
            XCTAssertEqual(got.row?.state.rawValue, e["state"] as? String, got.sessionId)
        }
        XCTAssertEqual(rows[0].row?.reason, "deploy [2J 7")
    }
}

/// The `claudectl session pause-status --json` object the menu-bar app reads
/// (claude-code/pause.js status(): request, rows with the row state spread
/// in plus name / cwd / pid / label, summary).
final class PauseStatusTests: XCTestCase {
    private static let a = "aaaa1111-0000-4000-8000-000000000001"
    private static let b = "bbbb2222-0000-4000-8000-000000000002"
    private static let json = """
        {"request":{"version":1,"id":"mf3k2a-1a2b3c","kind":"pause","at":1788263940000,
          "targets":["\(a)","\(b)"],"from":"macos",
          "sessions":[{"sessionId":"\(a)","name":"API","cwd":"/w/api"}]},
         "rows":[
          {"sessionId":"\(a)","name":"API","cwd":"/w/api","pid":11,"state":"not-safe",
           "terminal":true,"via":"rewake","verdict":"NOT_SAFE","reason":"deploy 7",
           "checkpoint":null,"label":"NOT SAFE: deploy 7"},
          {"sessionId":"\(b)","name":"WEB","cwd":"/w/web","pid":null,"state":"later-state",
           "terminal":false,"via":null,"verdict":null,"reason":null,"checkpoint":null,
           "label":"?"},
          {"sessionId":"../x","name":"bad","state":"safe"}],
         "summary":{"label":"ignored"}}
        """

    private func status() throws -> PauseStatus {
        let raw = try JSONSerialization.jsonObject(with: Data(Self.json.utf8))
        return try XCTUnwrap(Pause.parseStatus(raw))
    }

    func testParseStatusRecomputesTheSummary() throws {
        let st = try status()
        XCTAssertEqual(st.request?.id, "mf3k2a-1a2b3c")
        XCTAssertEqual(st.request?.from, .macos)
        XCTAssertEqual(st.rows.map(\.sessionId), [Self.a, Self.b], "an invalid id is dropped")
        XCTAssertEqual(
            st.rows[0].row,
            PauseRow(state: .notSafe, via: .rewake, verdict: .notSafe, reason: "deploy 7"))
        XCTAssertEqual(st.rows[0].pid, 11)
        XCTAssertNil(st.rows[1].pid)
        XCTAssertNil(st.rows[1].row, "an unknown state has no typed row")
        XCTAssertEqual(st.summary.label, "0/2 safe")
        XCTAssertEqual(st.summary.notSafe, 1)
        XCTAssertFalse(st.summary.done, "an unknown state is not terminal")
    }

    func testNoRequestYet() throws {
        let st = try XCTUnwrap(Pause.parseStatus(["request": NSNull(), "rows": [Any]()]))
        XCTAssertNil(st.request)
        XCTAssertEqual(st.rows, [])
        XCTAssertEqual(st.summary.label, "0/0 safe")
        XCTAssertNil(Pause.parseStatus("nope"))
    }

    func testPanelRowsJoinTargetsAndLiveSessions() throws {
        let live = [
            Waiting.LiveSession(pid: 11, sessionId: Self.a, name: "", cwd: "/w/api-2"),
            Waiting.LiveSession(pid: 13, sessionId: "cccc3333", name: "", cwd: "/w/docs/"),
            Waiting.LiveSession(pid: 14, sessionId: "dddd4444", name: "", cwd: "/"),
        ]
        let rows = Pause.panelRows(status: try status(), live: live)
        XCTAssertEqual(rows.map(\.sessionId), [Self.a, Self.b, "cccc3333", "dddd4444"])
        XCTAssertEqual(rows.map(\.name), ["API", "WEB", "docs", "dddd4444"], "the CLI's names")
        XCTAssertEqual(rows.map(\.live), [true, false, true, true])
        XCTAssertEqual(rows[0].cwd, "/w/api", "the CLI's cwd")
        XCTAssertEqual(rows[0].label, "NOT SAFE: deploy 7")
        XCTAssertEqual(rows[1].label, "later-state")
        XCTAssertNil(rows[2].row)
        XCTAssertEqual(rows[2].label, "running")
        XCTAssertEqual(Pause.panelRows(status: nil, live: []), [])
    }
}
