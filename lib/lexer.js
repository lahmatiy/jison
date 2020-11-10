// Basic Lexer implemented using JavaScript regular expressions
// MIT Licensed
const lexParser = require('lex-parser');
const version = require('../package.json').version;

// expand macros and convert matchers to RegExp's
function prepareRules(rules, macros, actions, tokens, startConditions, caseless) {
    const macrosNoParentsRx = macros ? new RegExp('\\{(' + Object.keys(macros).join('|') + ')\\}(?![?+*{])', 'g') : null;
    const macrosRx = macros ? new RegExp('\\{(' + Object.keys(macros).join('|') + ')\\}', 'g') : null;
    const newRules = [];

    actions.push('switch (__lexelActionId) {');

    rules.forEach((rule, i) => {
        if (!Array.isArray(rule[0])) {
            // implicit add to all inclusive start conditions
            for (const k in startConditions) {
                if (startConditions[k].inclusive) {
                    startConditions[k].rules.push(i);
                }
            }
        } else if (rule[0][0] === '*') {
            // Add to ALL start conditions
            for (const k in startConditions) {
                startConditions[k].rules.push(i);
            }

            rule.shift();
        } else {
            // Add to explicit start conditions
            for (const condition of rule.shift()) {
                startConditions[condition].rules.push(i);
            }
        }

        let pattern = rule[0];

        if (typeof pattern === 'string') {
            if (macrosRx) {
                pattern = pattern
                    .replace(macrosNoParentsRx, (_, ref) => macros[ref])
                    .replace(macrosRx, (_, ref) => '(' + macros[ref] + ')');
            }

            pattern = new RegExp(
                pattern.includes('|') ? '^(?:' + pattern + ')' : '^' + pattern,
                caseless ? 'i' : ''
            );
        }

        newRules.push(pattern);

        if (typeof rule[1] === 'function') {
            rule[1] = String(rule[1]).replace(/^\s*function\s*\(\)\s?\{/, '').replace(/\}\s*$/, '');
        }

        const action = tokens
            ? rule[1].replace(/return\s+('[^']+?'|"[^"]+?")/g, (m, s) =>
                'return ' + (tokens[s.slice(1, -1)] ||  s)
            )
            : rule[1];

        actions.push('case ' + i + ':{' + action + '\nbreak;}');
    });

    actions.push("}");

    return newRules;
}

// expand macros within macros
// FIXME: infinite loop is possible
function prepareMacros(macros) {
    const macrosRx = new RegExp('\\{(' + Object.keys(macros).join('|') + ')\\}', 'g')
    let cont = true;

    while (cont) {
        cont = false;

        for (const [name, value] of Object.entries(macros)) {
            macros[name] = value.replace(macrosRx, (m, ref) => {
                cont = true;
                return '(' + macros[ref] + ')';
            });
        }
    }

    return macros;
}

function prepareStartConditions (conditions) {
    const result = {};

    for (const [key, value] of Object.entries(conditions || {})) {
        result[key] = {
            rules: [],
            inclusive: !value
        };
    }

    return result;
}

function buildActions(dict, tokens) {
    const actions = [dict.actionInclude || '', 'var YYSTATE=YY_START;'];
    const tokenNameToIndex = Object.create(null);
    const rules = dict.rules;
    const macros = dict.macros ? prepareMacros(dict.macros) : null;

    if (dict.options && dict.options.flex) {
        rules.push(['.', 'console.log(yytext);']);
    }

    for (const key in tokens) {
        tokenNameToIndex[tokens[key]] = key;
    }

    this.rules = prepareRules(
        rules,
        macros,
        actions,
        tokens && tokenNameToIndex,
        this.conditions,
        this.options['case-insensitive']
    );

    var fun = actions
        .join('\n')
        .replace(/\b(yytext|yyleng|yylineno|yylloc)\b/g, 'yy_.$1');

    return 'function(yy,yy_,__lexelActionId,YY_START) {' + fun + '\n}';
}

function RegExpLexer(dict, input, tokens) {
    const opts = processGrammar(dict, tokens);
    const source = generateModuleBody(opts);
    const lexer = Function('return' + source)();
    
    lexer.yy = {};
    lexer.generateModule = () => generateModule(opts);

    if (input) {
        lexer.setInput(input);
    }

    return lexer;
}

RegExpLexer.prototype = {
    EOF: 1,

    parseError(str, details) {
        if (!this.yy.parser) {
            throw new Error(str);
        }

        this.yy.parser.parseError(str, details);
    },

    // resets the lexer, sets new input
    setInput(input, yy) {
        this.yy = yy || this.yy || {};
        this._input = input;
        this._more = this._backtrack = this.done = false;
        this.yylineno = this.yyleng = 0;
        this.yytext = this.matched = this.match = '';
        this.conditionStack = ['INITIAL'];
        this.offset = 0;
        this.yylloc = {
            first_line: 1,
            first_column: 0,
            last_line: 1,
            last_column: 0
        };

        if (this.options.ranges) {
            this.yylloc.range = [0, 0];
        }

        return this;
    },

    // consumes and returns one char from the input
    input() {
        var ch = this._input[0];
        this.yytext += ch;
        this.yyleng++;
        this.offset++;
        this.match += ch;
        this.matched += ch;
        var lines = ch.match(/(?:\r\n?|\n).*/g);

        if (lines) {
            this.yylineno++;
            this.yylloc.last_line++;
        } else {
            this.yylloc.last_column++;
        }

        if (this.options.ranges) {
            this.yylloc.range[1]++;
        }

        this._input = this._input.slice(1);
        return ch;
    },

    // unshifts one char (or a string) into the input
    unput(chunk) {
        var lines = chunk.split(/(?:\r\n?|\n)/g);
        var oldLines = this.yytext.split(/(?:\r\n?|\n)/g);

        this._input = chunk + this._input;
        this.offset -= chunk.length;
        this.yytext = this.yytext.slice(0, -chunk.length);
        //this.yyleng -= chunk.length;

        if (lines.length - 1) {
            this.yylineno -= lines.length - 1;
        }

        var r = this.yylloc.range;

        this.yylloc = {
            first_line: this.yylloc.first_line,
            last_line: this.yylineno + 1,
            first_column: this.yylloc.first_column,
            last_column: lines
                ? (lines.length === oldLines.length ? this.yylloc.first_column : 0) +
                    oldLines[oldLines.length - lines.length].length - lines[0].length
                : this.yylloc.first_column - chunk.length
        };

        if (this.options.ranges) {
            this.yylloc.range = [
                r[0],
                r[0] + this.yyleng - chunk.length
            ];
        }

        this.yyleng = this.yytext.length;

        return this;
    },

    // When called from action, caches matched text and appends it on next action
    more() {
        this._more = true;
        return this;
    },

    // When called from action, signals the lexer that this rule fails to match the input, so the next matching rule (regex) should be tested instead.
    reject() {
        if (this.options.backtrack_lexer) {
            this._backtrack = true;
            return this;
        }
        
        return this.parseError('Lexical error on line ' + (this.yylineno + 1) + '. You can only invoke reject() in the lexer when the lexer is of the backtracking persuasion (options.backtrack_lexer = true).\n' + this.showPosition(), {
            text: '',
            token: null,
            line: this.yylineno
        });
    },

    // retain first n characters of the match
    less(n) {
        this.unput(this.match.slice(n));
    },

    // displays already matched input, i.e. for error messages
    pastInput() {
        const past = this.matched.substr(0, this.matched.length - this.match.length);
        return (past.length > 20 ? '...':'') + past.substr(-20).replace(/\n/g, '');
    },

    // displays upcoming input, i.e. for error messages
    upcomingInput() {
        let next = this.match;

        if (next.length < 20) {
            next += this._input.substr(0, 20 - next.length);
        }

        return (next.substr(0,20) + (next.length > 20 ? '...' : '')).replace(/\n/g, '');
    },

    // displays the character position where the lexing error occurred, i.e. for error messages
    showPosition() {
        const pre = this.pastInput();

        return pre + this.upcomingInput() + `\n${'-'.repeat(pre.length)}^`;
    },

    // test the lexed token: return FALSE when not a match, otherwise return token
    test_match(match, rule) {
        let backup;

        if (this.options.backtrack_lexer) {
            // save context
            backup = {
                yylineno: this.yylineno,
                yylloc: {
                    first_line: this.yylloc.first_line,
                    last_line: this.yylloc.last_line,
                    first_column: this.yylloc.first_column,
                    last_column: this.yylloc.last_column
                },
                yytext: this.yytext,
                match: this.match,
                matched: this.matched,
                matches: this.matches,
                yyleng: this.yyleng,
                offset: this.offset,
                _more: this._more,
                _input: this._input,
                yy: this.yy,
                conditionStack: this.conditionStack.slice(0),
                done: this.done
            };

            if (this.options.ranges) {
                backup.yylloc.range = this.yylloc.range.slice(0);
            }
        }

        const ruleMatch = match[0];
        this.yytext += ruleMatch;
        this.match += ruleMatch;
        this.matched += ruleMatch;
        this.matches = match;
        this.yyleng = this.yytext.length;
        this.offset += this.yyleng;

        this._more = false;
        this._backtrack = false;
        this._input = this._input.slice(ruleMatch.length);

        // update loc & range
        const lineTerninator = /\r\n?|\n/g;
        let lastColumnOffset = -1;
        let ltMatch;
        while (ltMatch = lineTerninator.exec(ruleMatch)) {
            this.yylineno++;
            lastColumnOffset = ltMatch.index + ltMatch[0].length;
        }

        this.yylloc = {
            first_line: this.yylloc.last_line,
            last_line: this.yylineno + 1,
            first_column: this.yylloc.last_column,
            last_column: lastColumnOffset !== -1
                ? ruleMatch.length - lastColumnOffset
                : this.yylloc.last_column + ruleMatch.length
        };

        if (this.options.ranges) {
            this.yylloc.range = [this.offset - this.yyleng, this.offset];
        }

        // perform action
        const token = this.performAction.call(
            this,
            this.yy,
            this,
            rule,
            this.conditionStack[this.conditionStack.length - 1]
        );

        if (this.done && this._input) {
            this.done = false;
        }

        if (token) {
            if (typeof token === 'number' && this.yy.parser) {
                return this.yy.parser.terminals_[token];
            }

            return token;
        }
        
        if (this._backtrack) {
            // recover context
            Object.assign(this, backup);

            return false; // rule action called reject() implying the next rule should be tested instead.
        }

        return false;
    },

    // return next match in input
    next() {
        if (this.done) {
            return this.EOF;
        }

        if (!this._input) {
            this.done = true;
        }

        if (!this._more) {
            this.yytext = '';
            this.match = '';
        }

        const rules = this._currentRules();
        let match;
        let index;

        for (let i = 0; i < rules.length; i++) {
            const tempMatch = this._input.match(this.rules[rules[i]]);

            if (tempMatch && (!match || tempMatch[0].length > match[0].length)) {
                match = tempMatch;
                index = i;

                if (this.options.backtrack_lexer) {
                    const token = this.test_match(tempMatch, rules[i]);

                    if (token !== false) {
                        return token;
                    }
                    
                    if (this._backtrack) {
                        match = false;
                        continue; // rule action called reject() implying a rule MISmatch.
                    }

                    // else: this is a lexer rule which consumes input without producing a token (e.g. whitespace)
                    return false;
                }

                if (!this.options.flex) {
                    break;
                }
            }
        }

        if (match) {
            const token = this.test_match(match, rules[index]);

            if (token !== false) {
                return token;
            }

            // else: this is a lexer rule which consumes input without producing a token (e.g. whitespace)
            return false;
        }

        if (this._input === '') {
            return this.EOF;
        }
        
        this.parseError('Lexical error on line ' + (this.yylineno + 1) + '. Unrecognized text.\n' + this.showPosition(), {
            text: '',
            token: null,
            line: this.yylineno
        });
    },

    // return next match that has a token
    lex() {
        return this.next() || this.lex();
    },

    // activates a new lexer condition state (pushes the new lexer condition state onto the condition stack)
    begin(condition) {
        this.conditionStack.push(condition);
    },

    // pop the previously active lexer condition state off the condition stack
    popState() {
        const n = this.conditionStack.length - 1;

        return n > 0
            ? this.conditionStack.pop()
            : this.conditionStack[0];
    },

    // produce the lexer rule set which is active for the currently active lexer condition state
    _currentRules() {
        const lastCondition = this.conditionStack.length && this.conditionStack[this.conditionStack.length - 1];

        return this.conditions[lastCondition || 'INITIAL'].rules;
    },

    // return the currently active lexer condition state;
    // when an index argument is provided it produces the N-th previous condition state, if available
    topState(n) {
        n = this.conditionStack.length - 1 - Math.abs(n || 0);

        return n >= 0
            ? this.conditionStack[n]
            : 'INITIAL';
    },

    // alias for begin(condition)
    pushState(condition) {
        this.begin(condition);
    },

    // return the number of states pushed
    stateStackSize() {
        return this.conditionStack.length;
    }
};

// process the grammar and build final data structures and functions
function processGrammar(dict, tokens) {
    if (typeof dict === 'string') {
        dict = lexParser.parse(dict);
    }

    dict = dict || {};

    const options = dict.options || {};
    const opts = {};

    opts.options = options;
    opts.moduleType = options.moduleType;
    opts.moduleName = options.moduleName;

    opts.conditions = prepareStartConditions(dict.startConditions);
    opts.conditions.INITIAL = { rules: [], inclusive: true };

    opts.performAction = buildActions.call(opts, dict, tokens);
    opts.conditionStack = ['INITIAL'];

    opts.moduleInclude = (dict.moduleInclude || '').trim();

    return opts;
}

function generateModuleBody(opt) {
    const options = opt.options || {};
    let out = '{\n';

    out += 'options: ' + JSON.stringify(options);
    out += ',\nperformAction: ' + opt.performAction;
    out += ',\nrules: [' + opt.rules + ']';
    out += ',\nconditions: ' + JSON.stringify(opt.conditions);

    for (const [k, v] of Object.entries(RegExpLexer.prototype)) {
        if (!k.startsWith('generate')) {
            const method = v.toString().replace(
                /this\.options\.([a-zA-Z$_][a-zA-Z0-9$_]*)/g,
                (m, option) => option in options && typeof options[option] !== 'boolean'
                    ? m
                    : Boolean(options[option])
            );

            out += ',\n' + (typeof v !== 'function' || method.startsWith('function') ? k + ':' : '') + method;
        }
    }

    out += '\n}';

    return out;
}

function generateModule(opt) {
    opt = opt || {};

    const moduleName = opt.moduleName || 'lexer';
    let out = '/* Lexer generated by jison ' + version + ' */';

    out += '\nvar ' + moduleName + ' = (function(){\nvar lexer = '
        + generateModuleBody(opt);

    if (opt.moduleInclude) {
        out += ';\n' + opt.moduleInclude;
    }

    out += ';if (typeof module !== "undefined" && typeof exports === "object") module.exports = exports = lexer;';
    out += ';\nreturn lexer.lexer = lexer;\n})();';

    return out;
}

// generate lexer source from a grammar
RegExpLexer.generate = function generate(dict, tokens) {
    const opt = processGrammar(dict, tokens);

    return generateModule(opt);
};

module.exports = RegExpLexer;
