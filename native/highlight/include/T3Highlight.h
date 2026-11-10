#ifndef T3_HIGHLIGHT_H
#define T3_HIGHLIGHT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  uint32_t start;
  uint32_t end;
  uint8_t kind;
} T3HighlightToken;

typedef struct {
  T3HighlightToken *tokens;
  size_t count;
} T3HighlightResult;

/* UTF-8 input; returned start/end offsets address UTF-16 code units. */
T3HighlightResult t3_highlight_code(const char *code, size_t code_length,
                                  const char *language, size_t language_length);
void t3_highlight_free(T3HighlightResult result);

#ifdef __cplusplus
}
#endif

#endif
