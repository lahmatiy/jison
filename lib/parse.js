module.exports = function parse(input, ...parseArgs) {
    // use own constants for source generation reasons
    const SHIFT = 1;
    const REDUCE = 2;
    const ACCEPT = 3;
    const TERROR = 2;
    const EOF = 1;

    const popStack = n => {
        stack.length -= 2 * n;
        vstack.length -= n;
        lstack.length -= n;
    };
    const lex = /** @replace token stack */ () => {
        let token = lexer.lex() || EOF;

        // if token isn't its numeric value, convert
        if (typeof token !== 'number') {
            token = this.symbols_[token] || token;
        }

        return token;
    }; /** @replace */

    const lexer = Object.create(this.lexer);
    const ranges = lexer.options && lexer.options.ranges;
    const sharedYY = { // shared state
        ...this.yy,
        parser: this,
        lexer
    };

    lexer.setInput(input, sharedYY);

    if (typeof sharedYY.parseError === 'function') {
        this.parseError = sharedYY.parseError;
    }

    if (typeof lexer.yylloc == 'undefined') {
        lexer.yylloc = {};
    }

    const table = this.table;
    const yyval = {};
    let yylloc = lexer.yylloc;
    const stack = [0];
    const vstack = [null]; // semantic value stack
    const lstack = [yylloc]; // location stack
    // eslint-disable-next-line no-unused-vars
    let tstack = []; // token stack, used when lex supports token stacks
    let yytext = '';
    let yylineno = 0;
    let yyleng = 0;
    let recovering = 0;
    let symbol;
    let preErrorSymbol;
    while (true) {
        // retreive state number from top of stack
        let state = stack[stack.length - 1];
        let action;

        // use default actions if available
        if (this.defaultActions[state]) {
            action = this.defaultActions[state];
        } else {
            if (symbol === null || typeof symbol == 'undefined') {
                symbol = lex();
            }

            // read action for current state and first input
            action = table[state] && table[state][symbol];
        }

        // handle parse error
        if (!action || !action[0]) {
            let errorRuleDepth;
            let errStr = '';

            // Return the rule stack depth where the nearest error rule can be found.
            // Return FALSE when no error recovery rule was found.
            function locateNearestErrorRecoveryRule(state) {
                let stackProbe = stack.length - 1;
                let depth = 0;

                // try to recover from error
                while (true) {
                    // check for error recovery rule in this state
                    if (TERROR.toString() in table[state]) {
                        return depth;
                    }

                    if (state === 0 || stackProbe < 2) {
                        return false; // No suitable error recovery rule available.
                    }

                    stackProbe -= 2; // popStack(1): [symbol, action]
                    state = stack[stackProbe];
                    ++depth;
                }
            }

            if (!recovering) {
                // first see if there's any chance at hitting an error recovery rule:
                /** @cut recovery */errorRuleDepth = locateNearestErrorRecoveryRule(state);

                // Report error
                const expected = [];
                for (const p in table[state]) {
                    if (p in this.terminals_ && p > TERROR) {
                        expected.push('\'' + this.terminals_[p] + '\'');
                    }
                }

                errStr = lexer.showPosition
                    ? 'Parse error on line ' + (yylineno + 1) + ':\n' +
                        lexer.showPosition() + '\n' +
                        'Expecting ' + expected.join(', ') + ', got \'' + (this.terminals_[symbol] || symbol) + '\''
                    : 'Parse error on line ' + (yylineno + 1) + ': Unexpected ' +
                        (symbol === EOF ? 'end of input' : "'" + (this.terminals_[symbol] || symbol) + "'");

                this.parseError(errStr, {
                    text: lexer.match,
                    token: this.terminals_[symbol] || symbol,
                    line: lexer.yylineno,
                    loc: yylloc,
                    /** @cut recovery */recoverable: errorRuleDepth !== false,
                    expected
                });
            } else if (preErrorSymbol !== EOF) {
                /** @cut recovery */errorRuleDepth = locateNearestErrorRecoveryRule(state);
            }

            // just recovered from another error
            if (recovering === 3) {
                if (symbol === EOF || preErrorSymbol === EOF) {
                    throw new Error(errStr || 'Parsing halted while starting to recover from another error.');
                }

                // discard current lookahead and grab another
                yyleng = lexer.yyleng;
                yytext = lexer.yytext;
                yylineno = lexer.yylineno;
                yylloc = lexer.yylloc;
                symbol = lex();
            }

            // try to recover from error
            if (errorRuleDepth === false) {
                throw new Error(errStr || 'Parsing halted. No suitable error recovery rule available.');
            }

            popStack(errorRuleDepth);
            preErrorSymbol = symbol == TERROR ? null : symbol; // save the lookahead token
            symbol = TERROR; // insert generic error symbol as new lookahead
            state = stack[stack.length - 1];
            action = table[state] && table[state][TERROR];
            recovering = 3; // allow 3 real symbols to be shifted before reporting a new error
        }

        // this shouldn't happen, unless resolve defaults are off
        if (Array.isArray(action[0]) && action.length > 1) {
            throw new Error('Parse Error: multiple actions possible at state: ' + state + ', token: ' + symbol);
        }

        switch (action[0]) {
            case SHIFT:
                stack.push(symbol);
                vstack.push(lexer.yytext);
                lstack.push(lexer.yylloc);
                stack.push(action[1]); // push state
                symbol = null;

                if (!preErrorSymbol) { // normal execution/no error
                    yyleng = lexer.yyleng;
                    yytext = lexer.yytext;
                    yylineno = lexer.yylineno;
                    yylloc = lexer.yylloc;
                    if (recovering > 0) {
                        recovering--;
                    }
                } else {
                    // error just occurred, resume old lookahead f/ before error
                    symbol = preErrorSymbol;
                    preErrorSymbol = null;
                }

                break;

            case REDUCE: {
                const len = this.productions_[action[1]][1];
                const first = lstack[lstack.length - (len || 1)];
                const last = lstack[lstack.length - 1];

                // perform semantic action
                yyval.$ = vstack[vstack.length - len]; // default to $$ = $1
                // default location, uses first token for firsts, last for lasts
                yyval._$ = {
                    first_line: first.first_line,
                    last_line: last.last_line,
                    first_column: first.first_column,
                    last_column: last.last_column
                };

                if (ranges) {
                    yyval._$.range = [
                        first.range[0],
                        last.range[1]
                    ];
                }

                const actionResult = this.performAction.call(
                    yyval,
                    yytext,
                    yyleng,
                    yylineno,
                    sharedYY,
                    action[1],
                    vstack,
                    lstack,
                    ...parseArgs
                );

                if (typeof actionResult !== 'undefined') {
                    return actionResult;
                }

                // pop off stack
                if (len) {
                    popStack(len);
                }

                stack.push(this.productions_[action[1]][0]);    // push nonterminal (reduce)
                vstack.push(yyval.$);
                lstack.push(yyval._$);
                // goto new state = table[STATE][NONTERMINAL]
                stack.push(table[stack[stack.length - 2]][stack[stack.length - 1]]);
                break;
            }

            case ACCEPT:
                return true;
        }
    }
};
