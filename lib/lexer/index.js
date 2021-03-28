const { generateModuleBody, generateModule } = require('./generate');
const { processGrammar } = require('./process-grammar');

function Lexer(dict, tokens) {
    const grammar = processGrammar(dict, tokens);
    const source = generateModuleBody(grammar);
    const lexer = Function('return' + source)();

    lexer.generateModule = format => generateModule(grammar, format);

    return lexer;
}

// generate lexer source from a grammar
Lexer.generateModule = function generate(dict, tokens, format) {
    const grammar = processGrammar(dict, tokens);

    return generateModule(grammar, format);
};

module.exports = Lexer;
