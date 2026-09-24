import Foundation
import XCTest

@testable import ClaudeUsageCore

/// The release check reads GitHub's smart-HTTP ref advertisement instead of
/// running /usr/bin/git. The sample below has the real shape: service header,
/// flush, HEAD with NUL + capabilities, branches, annotated tags with their
/// peeled `^{}` entries, and tags that are not releases.
final class ReleaseTagsTests: XCTestCase {
    private let advertisement =
        "001e# service=git-upload-pack\n"
        + "0000015595a94ce6597d6c4996dd82686eae0f0734c115f78 HEAD\0multi_ack thin-pack "
        + "symref=HEAD:refs/heads/main agent=git/github-abc\n"
        + "003f5a94ce6597d6c4996dd82686eae0f0734c115f78 refs/heads/main\n"
        + "003e3a133fb6cc66e6a18bcbc98b7e5aac1fb31e8a85 refs/tags/v1.2.0\n"
        + "003eb0eab4b7214bd0b92d59964a85720c0b4243caa0 refs/tags/v1.10.0\n"
        + "004132e0ec4588830dff13c3dd63159fa4c9d6845313 refs/tags/v1.10.0^{}\n"
        + "003e9efbe370ffdae17c904b67525bca527820fedc0f refs/tags/v2.2.0\n"
        + "0042d708f904139f5a656c876cf6522bce53ed738863 refs/tags/v2.3.0-rc1\n"
        + "003dd708f904139f5a656c876cf6522bce53ed738863 refs/tags/v9.9\n"
        + "0040d708f904139f5a656c876cf6522bce53ed738863 refs/tags/v10.0.x\n"
        + "003dd708f904139f5a656c876cf6522bce53ed738863 refs/tags/nightly\n"
        + "0000"

    func testOnlyReleasedVersionsAreRead() {
        XCTAssertEqual(
            ReleaseTags.versions(inAdvertisement: advertisement), ["1.2.0", "1.10.0", "2.2.0"])
    }

    func testLatestComparesNumerically() {
        XCTAssertEqual(ReleaseTags.latest(inAdvertisement: advertisement), "2.2.0")
        XCTAssertEqual(
            ReleaseTags.latest(
                inAdvertisement: "003e00 refs/tags/v1.9.0\n003f00 refs/tags/v1.10.0\n"),
            "1.10.0")
    }

    func testNothingReleasedIsNil() {
        XCTAssertNil(ReleaseTags.latest(inAdvertisement: ""))
        XCTAssertNil(ReleaseTags.latest(inAdvertisement: "<html>rate limited</html>"))
        XCTAssertNil(
            ReleaseTags.latest(inAdvertisement: "0000015595a9 HEAD\0refs/tags/v9.9.9 caps\n"))
    }
}
