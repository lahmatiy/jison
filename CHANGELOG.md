## next

- Dropped support for Node.js prior 10.10
- Reworked `Lexer`'s code generation
- Changed `Lexer` constructor `Lexer(dict, input, tokens)` → `Lexer(dict, tokens)`
- Renamed `Lexer.generate()` method into `Lexer.generateModule()`
- Added `format` option for `Lexer#generateModule(format)` and `Lexer.generateModule(dict, tokes, format)` methods

## 0.4.18-remastered.1 (2020-11-10)

- Removed web site sources
- Removed CLI & bundling. Those things may back in the future but in fresh way
- Removed generator methods except `generateModule`
- Refactored to use ES6+ features, remove redundant abstractions, minor bug fixes
- Added support for function patterns in lexer
