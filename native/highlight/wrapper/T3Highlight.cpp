#include "T3Highlight.h"
#include "CodeBlockHighlighter.hpp"

#include <cstdlib>
#include <limits>
#include <string>

extern "C" T3HighlightResult t3_highlight_code(const char *code, size_t code_length,
                                             const char *language, size_t language_length) {
  if ((!code && code_length) || (!language && language_length)) return {nullptr, 0};
  try {
    const auto tokens = Markdown::highlightCode(
        std::string(code ? code : "", code_length),
        std::string(language ? language : "", language_length));
    if (tokens.empty() || tokens.size() > std::numeric_limits<size_t>::max() / sizeof(T3HighlightToken))
      return {nullptr, 0};
    auto *output = static_cast<T3HighlightToken *>(std::malloc(tokens.size() * sizeof(T3HighlightToken)));
    if (!output) return {nullptr, 0};
    for (size_t index = 0; index < tokens.size(); ++index) {
      const auto &token = tokens[index];
      output[index] = {token.start, token.end, static_cast<uint8_t>(token.type)};
    }
    return {output, tokens.size()};
  } catch (...) {
    return {nullptr, 0};
  }
}

extern "C" void t3_highlight_free(T3HighlightResult result) {
  std::free(result.tokens);
}
