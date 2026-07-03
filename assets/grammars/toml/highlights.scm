; Query from: https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/cf12346a3414fa1b06af75c79faebe7f76df080a/queries/toml/highlights.scm
; Source: nvim-treesitter @ cf12346a3414fa1b06af75c79faebe7f76df080a (vendored for offline use in vsx)
; Grammar wasm: tree-sitter-wasms@0.1.13 (prebuilt tree-sitter-toml.wasm)

(bare_key) @property

[
  (string)
  (quoted_key)
] @string

(boolean) @boolean

(comment) @comment @spell

(escape_sequence) @string.escape

(integer) @number

(float) @number.float

[
  (local_date)
  (local_date_time)
  (local_time)
  (offset_date_time)
] @string.special

"=" @operator

[
  "."
  ","
] @punctuation.delimiter

[
  "["
  "]"
  "[["
  "]]"
  "{"
  "}"
] @punctuation.bracket
