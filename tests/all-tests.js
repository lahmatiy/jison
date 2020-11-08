exports.testLexer = require("./lexer");
exports.testParser = require("./parser");

if (require.main === module) {
    require("test").run(exports);
}
