# Changelog

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
