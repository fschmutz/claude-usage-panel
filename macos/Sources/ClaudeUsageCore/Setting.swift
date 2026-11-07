import Foundation

/// A class whose `@Setting` properties live in UserDefaults. The app's view
/// model is one: `settingWillChange` is its `objectWillChange.send()`, so a
/// setting re-renders every view exactly like a `@Published` property did.
@MainActor
public protocol SettingsOwner: AnyObject {
    /// Called right before any setting is written.
    func settingWillChange()
    /// Where the settings are kept; `.standard` unless a test says otherwise.
    var settingsStore: UserDefaults { get }
}

extension SettingsOwner {
    public var settingsStore: UserDefaults { .standard }
}

/// A value UserDefaults stores as-is.
public protocol SettingValue {}
extension Bool: SettingValue {}
extension Int: SettingValue {}
extension Double: SettingValue {}
extension String: SettingValue {}

/// One preference, read from and written straight to UserDefaults under
/// `key`: no copy in memory to drift, no hand-written `didSet` per key, no
/// init re-reading every key. A missing or wrongly-typed stored value reads
/// as the default, which is never written until the user changes it. A
/// `didSet` on the property still runs after each write, for the settings
/// that act on change.
///
///     @Setting("refreshMinutes", default: 10) var refreshMinutes: Int
@propertyWrapper
public struct Setting<Value> {
    public let key: String
    public let defaultValue: Value
    private let decode: (Any?) -> Value?
    private let encode: (Value) -> Any

    public init(_ key: String, default value: Value) where Value: SettingValue {
        self.key = key
        defaultValue = value
        decode = { $0 as? Value }
        encode = { $0 }
    }

    /// An enum kept as its raw value; an unknown raw value reads as the default.
    public init(_ key: String, default value: Value)
    where Value: RawRepresentable, Value.RawValue: SettingValue {
        self.key = key
        defaultValue = value
        decode = { ($0 as? Value.RawValue).flatMap(Value.init(rawValue:)) }
        encode = { $0.rawValue }
    }

    public func read(_ store: UserDefaults) -> Value {
        decode(store.object(forKey: key)) ?? defaultValue
    }

    public func write(_ value: Value, to store: UserDefaults) {
        store.set(encode(value), forKey: key)
    }

    @available(*, unavailable, message: "@Setting is only available on SettingsOwner classes")
    public var wrappedValue: Value {
        get { fatalError("unavailable") }
        set { fatalError("unavailable") }
    }

    @MainActor
    public static subscript<Owner: SettingsOwner>(
        _enclosingInstance owner: Owner,
        wrapped _: ReferenceWritableKeyPath<Owner, Value>,
        storage storage: ReferenceWritableKeyPath<Owner, Setting<Value>>
    ) -> Value {
        get { owner[keyPath: storage].read(owner.settingsStore) }
        set {
            owner.settingWillChange()
            owner[keyPath: storage].write(newValue, to: owner.settingsStore)
        }
    }
}
