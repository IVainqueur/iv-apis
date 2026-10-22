import Foundation

// Compiles regular expressions with NSRegularExpression, the ICU engine behind the iOS app's
// RegexPatternProvider, the way the app does (flags become options). Reads a JSON array of
// {pattern, flags} and prints the JSON array of the indexes that do not compile.
let path = CommandLine.arguments[1]
let data = try! Data(contentsOf: URL(fileURLWithPath: path))
let items = try! JSONSerialization.jsonObject(with: data) as! [[String: String]]
var failed: [Int] = []
for (index, item) in items.enumerated() {
    var options: NSRegularExpression.Options = []
    let flags = item["flags"] ?? ""
    if flags.contains("i") { options.insert(.caseInsensitive) }
    if flags.contains("m") { options.insert(.anchorsMatchLines) }
    if flags.contains("s") { options.insert(.dotMatchesLineSeparators) }
    if (try? NSRegularExpression(pattern: item["pattern"] ?? "", options: options)) == nil { failed.append(index) }
}
print(String(data: try! JSONSerialization.data(withJSONObject: failed), encoding: .utf8)!)
