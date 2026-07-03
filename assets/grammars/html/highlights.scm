; Query from: https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/cf12346a3414fa1b06af75c79faebe7f76df080a/queries/html/highlights.scm (inlining inherited https://raw.githubusercontent.com/nvim-treesitter/nvim-treesitter/cf12346a3414fa1b06af75c79faebe7f76df080a/queries/html_tags/highlights.scm)
; Source: nvim-treesitter @ cf12346a3414fa1b06af75c79faebe7f76df080a (vendored for offline use in vsx)
; Grammar wasm: tree-sitter-wasms@0.1.13 (prebuilt tree-sitter-html.wasm)
; NOTE: OpenTUI's worker does not resolve nvim-treesitter '; inherits:' directives,
;       so html_tags is inlined below. Embedded css/js injections are omitted.

; --- inlined from queries/html_tags/highlights.scm ---
(tag_name) @tag

; (erroneous_end_tag_name) @error ; we do not lint syntax errors
(comment) @comment @spell

(attribute_name) @tag.attribute

((attribute
  (quoted_attribute_value) @string)
  (#set! priority 99))

(text) @none @spell

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading)
  (#eq? @_tag "title"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.1)
  (#eq? @_tag "h1"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.2)
  (#eq? @_tag "h2"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.3)
  (#eq? @_tag "h3"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.4)
  (#eq? @_tag "h4"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.5)
  (#eq? @_tag "h5"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.heading.6)
  (#eq? @_tag "h6"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.strong)
  (#any-of? @_tag "strong" "b"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.italic)
  (#any-of? @_tag "em" "i"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.strikethrough)
  (#any-of? @_tag "s" "del"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.underline)
  (#eq? @_tag "u"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.raw)
  (#any-of? @_tag "code" "kbd"))

((element
  (start_tag
    (tag_name) @_tag)
  (text) @markup.link.label)
  (#eq? @_tag "a"))

; NOTE: the upstream href/src @string.special.url pattern is dropped here — its
; `(#set! @string.special.url url @string.special.url)` directive is a 3-arg form
; that web-tree-sitter's strict query compiler rejects (breaking the whole query).
; Attribute values still color via the (quoted_attribute_value) @string rule above.

[
  "<"
  ">"
  "</"
  "/>"
] @tag.delimiter

"=" @operator

; --- queries/html/highlights.scm (own queries; '; inherits:' line dropped) ---

(doctype) @constant

"<!" @tag.delimiter

(entity) @character.special
