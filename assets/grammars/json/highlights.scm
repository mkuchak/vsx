; Query from: https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/cf12346a3414fa1b06af75c79faebe7f76df080a/queries/json/highlights.scm
; Source: nvim-treesitter @ cf12346a3414fa1b06af75c79faebe7f76df080a (vendored for offline use in vsx)
; Grammar wasm: tree-sitter-wasms@0.1.13 (prebuilt tree-sitter-json.wasm)

[
  (true)
  (false)
] @boolean

(null) @constant.builtin

(number) @number

(pair
  key: (string) @property)

(pair
  value: (string) @string)

(array
  (string) @string)

[
  ","
  ":"
] @punctuation.delimiter

[
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

("\"" @conceal
  (#set! conceal ""))

(escape_sequence) @string.escape

((escape_sequence) @conceal
  (#eq? @conceal "\\\"")
  (#set! conceal "\""))
