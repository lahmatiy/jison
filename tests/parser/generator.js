var Jison = require('../setup').Jison;
var Lexer = require('../setup').Lexer;
var assert = require('assert');
var { tmpdir } = require('os');

var fs = require('fs');
var path = require('path');

it('test commonjs module generator', function () {
    var lexData = {
        rules: [
            ['x', "return 'x';"],
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        tokens: 'x y',
        startSymbol: 'A',
        bnf: {
            'A': ['A x',
                'A y',
                '']
        }
    };

    var input = 'xyxxxy';
    var gen = new Jison.Generator(grammar);
    gen.lexer = new Lexer(lexData);

    var module = { exports: {} };
    var parser = Function('module', 'exports', 'return' + gen.generateModule())(module, module.exports);

    assert.ok(parser.parse(input));
});

it('test module generator', function () {
    var lexData = {
        rules: [
            ['x', "return 'x';"],
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        tokens: 'x y',
        startSymbol: 'A',
        bnf: {
            'A': ['A x',
                'A y',
                '']
        }
    };

    var input = 'xyxxxy';
    var gen = new Jison.Generator(grammar);
    gen.lexer = new Lexer(lexData);

    var parser = new Function('return' + gen.generateModule())();

    assert.ok(parser.parse(input));
});

it('test module generator with module name', function () {
    var lexData = {
        rules: [
            ['x', "return 'x';"],
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        tokens: 'x y',
        startSymbol: 'A',
        bnf: {
            'A': ['A x',
                'A y',
                '']
        }
    };

    var input = 'xyxxxy';
    var gen = new Jison.Generator(grammar);
    gen.lexer = new Lexer(lexData);

    var parser = new Function('return' + gen.generateModule())();

    assert.ok(parser.parse(input));
});

it('test module include', function () {
    var grammar = {
        'comment': 'ECMA-262 5th Edition, 15.12.1 The JSON Grammar. (Incomplete implementation)',
        'author': 'Zach Carter',

        'lex': {
            'macros': {
                'digit': '[0-9]',
                'exp': '([eE][-+]?{digit}+)'
            },
            'rules': [
                ['\\s+', '/* skip whitespace */'],
                ['-?{digit}+(\\.{digit}+)?{exp}?', "return 'NUMBER';"],
                ['"[^"]*', function(yytext, yyleng) {
                    if (yytext.charAt(yyleng - 1) == '\\') {
                    // remove escape
                        yytext = yytext.substr(0,yyleng - 2);
                        this.more();
                    } else {
                        yytext = yytext.substr(1); // swallow start quote
                        this.input(); // swallow end quote
                        return 'STRING';
                    }
                }],
                ['\\{', "return '{'"],
                ['\\}', "return '}'"],
                ['\\[', "return '['"],
                ['\\]', "return ']'"],
                [',', "return ','"],
                [':', "return ':'"],
                ['true\\b', "return 'TRUE'"],
                ['false\\b', "return 'FALSE'"],
                ['null\\b', "return 'NULL'"]
            ]
        },

        'tokens': 'STRING NUMBER { } [ ] , : TRUE FALSE NULL',
        'start': 'JSONText',

        'bnf': {
            'JSONString': ['STRING'],

            'JSONNumber': ['NUMBER'],

            'JSONBooleanLiteral': ['TRUE', 'FALSE'],


            'JSONText': ['JSONValue'],

            'JSONValue': ['JSONNullLiteral',
                'JSONBooleanLiteral',
                'JSONString',
                'JSONNumber',
                'JSONObject',
                'JSONArray'],

            'JSONObject': ['{ }',
                '{ JSONMemberList }'],

            'JSONMember': ['JSONString : JSONValue'],

            'JSONMemberList': ['JSONMember',
                'JSONMemberList , JSONMember'],

            'JSONArray': ['[ ]',
                '[ JSONElementList ]'],

            'JSONElementList': ['JSONValue',
                'JSONElementList , JSONValue']
        }
    };

    var gen = new Jison.Generator(grammar);
    var parser = new Function('return' + gen.generateModule())();

    assert.ok(parser.parse(JSON.stringify(grammar.bnf)));
});

it('test module include code', function () {
    var lexData = {
        rules: [
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        bnf: {
            'E': [['E y', 'return test();'],
                '']
        },
        moduleInclude: 'function test(val) { return 1; }'
    };

    var gen = new Jison.Generator(grammar);
    gen.lexer = new Lexer(lexData);

    var parser = new Function('return' + gen.generateModule())();

    assert.equal(parser.parse('y'), 1, 'semantic action');
});

it('test lexer module include code', function () {
    var lexData = {
        rules: [
            ['y', 'return test();']
        ],
        moduleInclude: 'function test() { return 1; }'
    };
    var grammar = {
        bnf: {
            'E': [['E y', 'return $2;'],
                '']
        }
    };

    var gen = new Jison.Generator(grammar);
    gen.lexer = new Lexer(lexData);
    var parser = new Function('return' + gen.generateModule())();

    assert.equal(parser.parse('y'), 1, 'semantic action');
});

it('test generated parser instance creation', function () {
    var grammar = {
        lex: {
            rules: [
                ['y', "return 'y'"]
            ]
        },
        bnf: {
            'E': [['E y', 'return $2;'],
                '']
        }
    };

    var gen = new Jison.Generator(grammar);
    var parser = new Function('return' + gen.generateModule())();

    var p = new parser.Parser;

    assert.equal(p.parse('y'), 'y', 'semantic action');

    parser.blah = true;

    assert.notEqual(parser.blah, p.blah, "shouldn't inherit props");
});

it('test module include code using generator from parser', function () {
    var lexData = {
        rules: [
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        bnf: {
            'E': [['E y', 'return test();'],
                '']
        },
        moduleInclude: 'function test(val) { return 1; }'
    };

    var gen = new Jison.Parser(grammar);
    gen.lexer = new Lexer(lexData);

    var parser = new Function('return' + gen.generateModule())();

    assert.equal(parser.parse('y'), 1, 'semantic action');
});

it('test module include with each generator type', function () {
    var lexData = {
        rules: [
            ['y', "return 'y';"]
        ]
    };
    var grammar = {
        bnf: {
            'E': [['E y', 'return test();'],
                '']
        },
        moduleInclude: 'var TEST_VAR;'
    };

    var gen = new Jison.Parser(grammar);
    gen.lexer = new Lexer(lexData);
    ['generateModule']
        .map(function(type) {
            var source = gen[type]();
            assert.ok(/TEST_VAR/.test(source), type + ' supports module include');
        });
});

// test for issue #246
it('test compiling a parser/lexer', function () {
    var grammar =
      '// Simple "happy happy joy joy" parser, written by Nolan Lawson\n' +
      '// Based on the song of the same name.\n\n' +
      '%lex\n%%\n\n\\s+                   /* skip whitespace */\n' +
      '("happy")             return \'happy\'\n' +
      '("joy")               return \'joy\'\n' +
      '<<EOF>>               return \'EOF\'\n\n' +
      '/lex\n\n%start expressions\n\n' +
      '%ebnf\n\n%%\n\n' +
      'expressions\n    : e EOF\n        {return $1;}\n    ;\n\n' +
      'e\n    : phrase+ \'joy\'? -> $1 + \' \' + yytext \n    ;\n\n' +
      'phrase\n    : \'happy\' \'happy\' \'joy\' \'joy\' ' +
      ' -> [$1, $2, $3, $4].join(\' \'); \n    ;';

    var parser = new Jison.Parser(grammar);
    var tmpFile = path.resolve(tmpdir(), 'tmp-parser.js');

    fs.writeFileSync(tmpFile, parser.generateModule('cjs'));

    try {
        var parser2 = require(tmpFile);

        assert.ok(parser.parse('happy happy joy joy joy') === 'happy happy joy joy joy',
            'original parser works');
        assert.ok(parser2.parse('happy happy joy joy joy') === 'happy happy joy joy joy',
            'generated parser works');
    } finally {
        fs.unlinkSync(tmpFile);
    }
});
