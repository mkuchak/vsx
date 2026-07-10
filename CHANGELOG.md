# Changelog

## [0.3.7](https://github.com/mkuchak/vsx/compare/v0.3.6...v0.3.7) (2026-07-10)

### Features

* **scroll:** lock trackpad scroll gestures to their dominant axis ([8d3ff5e](https://github.com/mkuchak/vsx/commit/8d3ff5e047ba9447bf2abe9c5974e73e94fa4e0b))

## [0.3.6](https://github.com/mkuchak/vsx/compare/v0.3.5...v0.3.6) (2026-07-09)

### Bug Fixes

* **repos:** don't crash repo discovery when a scanned dir vanishes ([adde1fb](https://github.com/mkuchak/vsx/commit/adde1fbab7089498aef6996c403cc74e198d8857))

## [0.3.5](https://github.com/mkuchak/vsx/compare/v0.3.4...v0.3.5) (2026-07-09)

### Features

* **diff:** add horizontal scrollbars to the diff panes ([c8216aa](https://github.com/mkuchak/vsx/commit/c8216aac5c90456d0dbbd56194e5727492387b3c))

### Bug Fixes

* **installer:** resolve releases via github.com redirect, not the API ([8c16725](https://github.com/mkuchak/vsx/commit/8c16725fe9d3ae99181432d6585cd17f4da066b2))
* **scm:** truncate long filenames instead of wrapping them invisible ([2a1cebb](https://github.com/mkuchak/vsx/commit/2a1cebb56711854777339f2b35a466e5d917fba6))

## [0.3.4](https://github.com/mkuchak/vsx/compare/v0.3.3...v0.3.4) (2026-07-08)

### Features

* **statusbar:** add quit button cell with hover/pressed states ([acc0adf](https://github.com/mkuchak/vsx/commit/acc0adf84c827f55417d74de962011f13b4a8e44))
* **workbench:** confirm before quitting via status bar button ([ac6b3db](https://github.com/mkuchak/vsx/commit/ac6b3db7d1ef4d18e17e510a9d0cf76c31c9d74a))

## [0.3.3](https://github.com/mkuchak/vsx/compare/v0.3.2...v0.3.3) (2026-07-08)

### Features

* **cli:** add vsx update subcommand ([d48cfac](https://github.com/mkuchak/vsx/commit/d48cfac4bb3e3928a332d662062dcfd8cf4e0a59))
* **keybinding:** add ctrl+alt+q as alternate quit chord ([ef5d125](https://github.com/mkuchak/vsx/commit/ef5d12595789575a6b701675e3919978b63b20b4))

## [0.3.2](https://github.com/mkuchak/vsx/compare/v0.3.1...v0.3.2) (2026-07-08)

### Features

* **diff:** compute intra-line emphasis ranges via char-level diffing ([ce1efc4](https://github.com/mkuchak/vsx/commit/ce1efc4b9afc6c58efdbb6df9ab62183b05a02d9))
* **diff:** render intra-line emphasis in the diff view ([97f85a6](https://github.com/mkuchak/vsx/commit/97f85a6d39ec2da87b2aefb340f80c192a96170b))
* **diff:** resolve true rename deltas via oldPath threading ([26eff6f](https://github.com/mkuchak/vsx/commit/26eff6f12c7cd426b111d6c856eac7624b0e3cf8))
* **editor:** overhaul text selection, navigation, and scrolling behavior ([fe069c3](https://github.com/mkuchak/vsx/commit/fe069c3df1efac8ff20e398c734af496ffe83a45))
* **search:** search the workspace as you type ([7868acb](https://github.com/mkuchak/vsx/commit/7868acb529f7895f6890ea70b1e19bd9987cae55))
* **ui:** rename SCM tab to Source and reorder sidebar tabs ([6562cd6](https://github.com/mkuchak/vsx/commit/6562cd63070f7bb888dbde50714d763f5a3bcb82))
* **ui:** use a thin bar cursor across all text inputs ([036961d](https://github.com/mkuchak/vsx/commit/036961d7d0cb305bea833b65f2ec96f5c82e59dc))

### Bug Fixes

* **diff:** reload DiffPane in the background without unmounting content ([bd2a6f0](https://github.com/mkuchak/vsx/commit/bd2a6f03b1591f0ffb8604d45af9e12ca57c0867))
* **editor:** convert highlight offsets to OpenTUI's native column space ([c158499](https://github.com/mkuchak/vsx/commit/c1584995889380e14baf2f1d4277b639ffc0fae5))
* **git:** spawn git with GIT_OPTIONAL_LOCKS=0 to stop watcher feedback loops ([f1c5db9](https://github.com/mkuchak/vsx/commit/f1c5db9c99f85f109a85bb0d4e2f5c1f770c7122))
* **scm:** open diffs for every row kind and swap Enter/o ([a0dd3ca](https://github.com/mkuchak/vsx/commit/a0dd3ca2621ee80cc20e807b9e2b5cd3361ec939))

## [0.3.1](https://github.com/mkuchak/vsx/compare/v0.3.0...v0.3.1) (2026-07-07)

### Bug Fixes

* **install:** fail-closed checksums, safe version pruning, bun fallback ([a594e99](https://github.com/mkuchak/vsx/commit/a594e99c24aab3dfa2a7dc2020246073d8428fb7))
* **quick-open:** gate the frecency boost to label-tier matches ([b7de485](https://github.com/mkuchak/vsx/commit/b7de48554598e6595c5d9bd96590dcb3f83b4a39))
* **release:** narrow the loop guard and gate on releasable commits ([83a51fd](https://github.com/mkuchak/vsx/commit/83a51fd956ef30addf67e4cc8a276a2d1624cec3))

## [0.3.0](https://github.com/mkuchak/vsx/compare/v0.2.1...v0.3.0) (2026-07-05)

### Features

* **explorer:** add a Collapse All command and footer button ([5ab29eb](https://github.com/mkuchak/vsx/commit/5ab29eb94090de9feddca06e4e6faf76fc344dba))
* **explorer:** persist expanded folders in the workbench store ([34fe91d](https://github.com/mkuchak/vsx/commit/34fe91d448b72421211e871c6e8c2552de00c9a0))

## [0.2.1](https://github.com/mkuchak/vsx/compare/v0.2.0...v0.2.1) (2026-07-05)

### Bug Fixes

* **install:** stop the installer exiting 1 after a successful install ([b646934](https://github.com/mkuchak/vsx/commit/b64693495970c7335034d8bb778f3a4f7b562327))
* **test:** stop hardcoding a release version in cli.test.tsx ([2b4dc09](https://github.com/mkuchak/vsx/commit/2b4dc092e205d48fc8795177f87a5692b1d1d8ca))

## 0.2.0 (2026-07-04)

### Features

* **cli:** add --version/-v flag ([d7dd0c7](https://github.com/mkuchak/vsx/commit/d7dd0c76ee66423528be0ae2c4693cdb6426e98d))
* **cli:** support opening a file via vsx <file> on boot ([1ed8e82](https://github.com/mkuchak/vsx/commit/1ed8e82b578d195ceb13c61a6ba06cf387785e53))
* **diff:** show full-file diff with change-block navigation and theming ([5730fdd](https://github.com/mkuchak/vsx/commit/5730fdd3bb1582807a3a9983ca338014f8065a05))
* **editor:** add move-line, line-number gutter, word wrap and scrollbars ([5fe0fb8](https://github.com/mkuchak/vsx/commit/5fe0fb8867277cf88dc33aea7a59d8524ed91ab3))
* **editor:** add shift+click and multi-click drag selection ([6b34e3b](https://github.com/mkuchak/vsx/commit/6b34e3b2b4e3fa7158dc2b62755d69a2d55cbc16))
* **file-history:** add persisted frecency file-history service ([58b59be](https://github.com/mkuchak/vsx/commit/58b59be1633c098438d1543fb89066ee4e6ff99f))
* **git:** add commitStats and grep to GitService ([eb7468c](https://github.com/mkuchak/vsx/commit/eb7468c74378d82faad3a52505d179f2cdca4338))
* **highlighting:** bundle grammars, fix tree-sitter worker boot, centralize theme ([5171686](https://github.com/mkuchak/vsx/commit/5171686a599dd2389cffe66a88836f98ecb92e3f))
* **history:** add commit details overlay with stats and dates ([4f1cd73](https://github.com/mkuchak/vsx/commit/4f1cd7335ab3bdc2edd6a2db3d37f384fee8751f))
* **install:** add cross-platform install/update script ([879f71e](https://github.com/mkuchak/vsx/commit/879f71eda0d758625c3e2cbc063299cd1a8a7cf5))
* **keybindings:** add macOS Cmd variants and Developer Key Inspector ([9ac854c](https://github.com/mkuchak/vsx/commit/9ac854c851058001b10afa999d3994476a880c62))
* **model:** add document, workbench, and split-size state models ([a286dcb](https://github.com/mkuchak/vsx/commit/a286dcb4997c52d4f5021379d34eb18d5a421ea5))
* **quick-open:** browse absolute and home paths ([e5b31b0](https://github.com/mkuchak/vsx/commit/e5b31b01d6207e60d1077068fb34a5e96b65a848))
* **quick-open:** rank and recommend files by frecency history ([1c24b95](https://github.com/mkuchak/vsx/commit/1c24b95bee4be0b4b495cd42789195b58e28901e))
* **scm:** add row/group action buttons, directory tree view, and render caps ([7e6907e](https://github.com/mkuchak/vsx/commit/7e6907e142a81c84b319e9eed12959769aa4f8d4))
* **search:** add workspace search backend, find-in-file widget, and global search panel ([a0a64fb](https://github.com/mkuchak/vsx/commit/a0a64fb5df496fd9673b750921eb0c7def444a20))
* **services:** add git, workspace, and editor support services ([b9a4d84](https://github.com/mkuchak/vsx/commit/b9a4d8435416d22e79bb428bb79d63929a31cf3f))
* **ui:** add editor, sidebar, and dialog components ([4e1d571](https://github.com/mkuchak/vsx/commit/4e1d57185e4b222f5dd2cebe8f2b7160f400d8c0))
* **workbench:** add sidebar collapse and global Ctrl+C fallback ([8ce2ce3](https://github.com/mkuchak/vsx/commit/8ce2ce3109218c8b308a727b7acd3bd08b2563c1))
* **workbench:** assemble the app shell, providers, and CLI entry point ([796a93c](https://github.com/mkuchak/vsx/commit/796a93c6d9092ba30c4abe041e29faa2259549bc))
* **workbench:** wire keybindings, Key Inspector, find widget, and search panel into the app shell ([8099317](https://github.com/mkuchak/vsx/commit/809931718034fbc2bf01c1a5d076fcd84d42d170))

### Bug Fixes

* **ci:** upgrade pinned Bun from 1.2.3 to 1.3.14 ([7904a13](https://github.com/mkuchak/vsx/commit/7904a1399b9317219165833591347097d4e32af5))
* **install:** run installer when piped via stdin under set -u ([d8c66bd](https://github.com/mkuchak/vsx/commit/d8c66bd7928b447aed638c0f193cfcf1229df1dd))
* **repos:** stop filtering GitWatcher's git-dir watch by filename ([c2187b4](https://github.com/mkuchak/vsx/commit/c2187b42259252ddd725ffda31253c9056f0f3c2))
* **test:** make regex search case-sensitive in the git-ERE dialect test ([7e8e712](https://github.com/mkuchak/vsx/commit/7e8e712bc6df49fdb0fad27a78e183aabac82f95))
* **test:** pin git init to -b main across test fixtures ([941774a](https://github.com/mkuchak/vsx/commit/941774a34c60ebcdfc6ddaacd94bc983fbe2c55b))
