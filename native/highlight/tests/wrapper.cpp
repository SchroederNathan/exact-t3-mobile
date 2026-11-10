#include "T3Highlight.h"
#include "CodeBlockHighlighter.hpp"

#include <cassert>
#include <codecvt>
#include <iostream>
#include <locale>
#include <string>
#include <utility>
#include <vector>

static size_t compare(const std::string &code, const std::string &language) {
  const auto expected = Markdown::highlightCode(code, language);
  const auto actual = t3_highlight_code(code.data(), code.size(), language.data(), language.size());
  assert(expected.size() == actual.count);
  std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t> converter;
  const auto utf16 = converter.from_bytes(code);
  uint32_t previous = 0;
  for (size_t index = 0; index < actual.count; ++index) {
    const auto token = actual.tokens[index];
    assert(token.start == expected[index].start && token.end == expected[index].end);
    assert(token.kind == static_cast<uint8_t>(expected[index].type));
    assert(token.start >= previous && token.end > token.start && token.end <= utf16.size());
    assert(token.start == 0 || !(utf16[token.start] >= 0xDC00 && utf16[token.start] <= 0xDFFF));
    assert(token.end == utf16.size() || !(utf16[token.end] >= 0xDC00 && utf16[token.end] <= 0xDFFF));
    previous = token.end;
  }
  const size_t count = actual.count;
  t3_highlight_free(actual);
  return count;
}

int main() {
  const std::vector<std::pair<std::string, std::string>> samples = {
    {"json", "{\"emoji\": \"💡\", \"count\": 42, \"enabled\": true}"},
    {"html", "<h1 class=\"title\">Hello</h1>"},
    {"css", ".title { color: red; margin: 2px; }"},
    {"markdown", "# Heading\n\n**strong** and [link](https://example.com)"},
    {"yaml", "name: sample\ncount: 42\nvalid: true"},
    {"go", "package main\nfunc main() { println(42) }"},
    {"java", "class Example { static int answer = 42; }"},
    {"javascript", "const emoji = \"💡\"; const answer = 42; // café"},
    {"python", "def greet(name):\n    return f'Hello {name} 🌍'\n"},
    {"c", "int main(void) { return 42; }"},
    {"rust", "fn main() { let answer: u32 = 42; }"},
    {"bash", "#!/bin/bash\necho \"hello $USER\"\n"},
    {"typescript", "const emoji: string = \"💡\"; const answer: number = 42;"},
    {"tsx", "const view = <Button disabled={false}>Go</Button>;"},
  };
  for (const auto &[language, code] : samples) {
    const size_t count = compare(code, language);
    assert(count > 0);
    std::cout << language << ": " << count << " matching tokens\n";
  }
  assert(compare(samples[7].second, "JS") == compare(samples[7].second, "javascript"));
  assert(compare(samples[9].second, "not-a-language") == 0);
  compare(std::string("const a = 1;\0const b = 2;", 25), "javascript");
  assert(compare("", "json") == 0);
  assert(compare(std::string(50 * 1024 + 1, 'x'), "javascript") == 0);
  assert(compare(std::string(2000, '\n'), "javascript") == 0);
  const std::string code = "const value = \"💡\"; const after = 42;";
  const auto tokens = t3_highlight_code(code.data(), code.size(), "javascript", 10);
  bool foundNumber = false;
  const auto numberStart = std::u16string(u"const value = \"💡\"; const after = ").size();
  for (size_t index = 0; index < tokens.count; ++index) {
    if (tokens.tokens[index].kind == 4) {
      assert(tokens.tokens[index].start == numberStart && tokens.tokens[index].end == numberStart + 2);
      foundNumber = true;
    }
  }
  assert(foundNumber);
  t3_highlight_free(tokens);
  assert(t3_highlight_code(nullptr, 1, "js", 2).count == 0);
  assert(t3_highlight_code("x", 1, nullptr, 1).count == 0);
  t3_highlight_free({nullptr, 0});
  std::cout << "PASS: 14 grammars, aliases, Unicode boundaries, wrapper parity, fallback limits, and invalid C inputs\n";
}
