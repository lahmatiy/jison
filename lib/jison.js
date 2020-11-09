// Jison, an LR(0), SLR(1), LARL(1), LR(1) Parser Generator
// Zachary Carter <zach@carter.name>
// MIT X Licensed

const Lexer = require('./lexer');
const ebnfParser = require('ebnf-parser');
const version = require('../package.json').version;

const SHIFT = 1;
const REDUCE = 2;
const ACCEPT = 3;

const Jison = exports.Jison = exports;
Jison.version = version;
Jison.print = console.log;
Jison.Generator = createGenerator;
Jison.Parser = function(grammar, options) {
    const gen = createGenerator(grammar, options);
    return gen.createParser();
}

function createGenerator(grammar, options) {
    const opt = { ...grammar.options, ...options };

    switch (opt.type) {
        case 'lr0': return new LR0Generator(grammar, opt);
        case 'slr': return new SLRGenerator(grammar, opt);
        case 'lr':
        case 'lr1': return new LR1Generator(grammar, opt);
        case 'll':  return new LLGenerator(grammar, opt);
        case 'lalr':
        default:    return new LALRGenerator(grammar, opt);
    }
}

function addMissed(a, b) {
    const index = new Set(a);
    let added = false;

    for (const item of b) {
        if (!index.has(item)) {
            added = a.push(item) !== 0 || added;
        }
    }

    return added;
}

class Nonterminal {
    constructor(symbol) {
        this.symbol = symbol;
        this.productions = [];
        this.first = [];
        this.follows = [];
        this.nullable = false;
    }
    toString() {
        return [
            this.symbol,
            this.nullable ? 'nullable' : 'not nullable',
            'Firsts: ' + this.first.join(', '),
            'Follows: ' + this.follows.join(', '),
            'Productions:\n  ' + this.productions.join('\n  ')
        ].join('\n');
    }
}

class Production {
    constructor(symbol, handle, id) {
        this.symbol = symbol;
        this.handle = handle;
        this.id = id;
        this.nullable = false;
        this.first = [];
        this.precedence = 0;
    }
    toString() {
        return this.symbol + " -> " + this.handle.join(' ');
    }
}

function buildProduction(id, handle, symbol, addSymbol, actionGroups) {
    let rhs;

    if (Array.isArray(handle)) {
        rhs = typeof handle[0] === 'string'
            ? handle[0].trim().split(' ')
            : handle[0].slice(0);

        rhs.forEach(addSymbol);

        if (typeof handle[1] === 'string' || handle.length == 3) {
            // semantic action specified
            const label = 'case ' + id + ':';
            let action = handle[1];

            // replace named semantic values ($nonterminal)
            if (/[$@][a-zA-Z]/.test(action)) {
                const count = {};
                const names = {};

                for (let i = 0; i < rhs.length; i++) {
                    // check for aliased names, e.g., id[alias]
                    let rhs_i = rhs[i].match(/\[[a-zA-Z][a-zA-Z0-9_-]*\]/);

                    if (rhs_i) {
                        rhs_i = rhs_i[0].slice(1, -1);
                        rhs[i] = rhs[i].substr(0, rhs[i].indexOf('['));
                    } else {
                        rhs_i = rhs[i];
                    }

                    if (names[rhs_i]) {
                        names[rhs_i + (++count[rhs_i])] = i + 1;
                    } else {
                        names[rhs_i] = i + 1;
                        names[rhs_i + "1"] = i + 1;
                        count[rhs_i] = 1;
                    }
                }

                action = action
                    .replace(/([@$])([a-zA-Z][a-zA-Z0-9_]*)/g, (str, prefix, pl) =>
                        names[pl] ? prefix + names[pl] : str
                    );
            }

            action = action
                // replace references to $$ with this.$, and @$ with this._$
                .replace(/([^'"])\$\$|^\$\$/g, '$1this.$')
                .replace(/@[0$]/g, 'this._$')

                // replace semantic value references ($n) with stack value (stack[n])
                .replace(/\$(-?\d+)/g, (_, n) =>
                    '$$[$0' + (parseInt(n, 10) - rhs.length || '') + ']'
                )
                // same as above for location references (@n)
                .replace(/@(-?\d+)/g, (_, n) =>
                    '_$[$0' + (n - rhs.length || '') + ']'
                );

            if (action in actionGroups) {
                actionGroups[action].push(label);
            } else {
                actionGroups[action] = [label];
            }
        }

        // strip aliases
        rhs = rhs.map(s => s.replace(/\[[a-zA-Z_][a-zA-Z0-9_-]*\]/g, ''));
    } else {
        // no action -> don't care about aliases; strip them.
        rhs = handle
            .replace(/\[[a-zA-Z_][a-zA-Z0-9_-]*\]/g, '')
            .trim()
            .split(' ');

        rhs.forEach(addSymbol);
    }

    return new Production(symbol, rhs, id);
}

class Generator {
    constructor(grammar, opt) {
        if (typeof grammar === 'string') {
            grammar = ebnfParser.parse(grammar);
        }

        const options = { ...grammar.options, ...opt };

        this.DEBUG = options.debug || false;
        this.terms = Object.create(null);
        this.symbols = [];
        this.operators = Object.create(null);
        this.productions = [];
        this.conflicts = 0;
        this.resolutions = [];
        this.options = options;
        this.parseParams = grammar.parseParams;
        this.yy = {}; // accessed as yy free variable in the parser/lexer actions

        // source included in semantic action execution scope
        if (grammar.actionInclude) {
            this.actionInclude = typeof grammar.actionInclude === 'function'
                ? String(grammar.actionInclude)
                    .replace(/^\s*function\s*\(\) \{/, '')
                    .replace(/\}\s*$/, '')
                : grammar.actionInclude;
        }

        this.moduleInclude = grammar.moduleInclude || '';
        this.processGrammar(grammar);

        this.lexer = grammar.lex
            ? new Lexer(grammar.lex, null, this.terminals_)
            : null;
    }

    processGrammar(grammar) {
        if (this.DEBUG) {
            this.trace("Processing grammar.")
        }

        let bnf = grammar.bnf;
        let tokens = grammar.tokens;
        this.nonterminals = Object.create(null);

        if (!bnf && grammar.ebnf) {
            bnf = ebnfParser.transform(grammar.ebnf);
        }

        if (tokens) {
            tokens = typeof tokens === 'string'
                ? tokens.trim().split(' ')
                : tokens.slice(0);
        }

        // calculate precedence of operators
        this.operators = processOperators(grammar.operators);

        // build productions from cfg
        this.buildProductions(bnf, this.productions, this.nonterminals, this.symbols, this.operators);

        if (tokens && this.terminals.length !== tokens.length) {
            this.trace("Warning: declared tokens differ from tokens found in rules.");
            this.trace(this.terminals);
            this.trace(tokens);
        }

        // augment the grammar
        this.augmentGrammar(grammar);
    }

    augmentGrammar(grammar) {
        if (this.productions.length === 0) {
            throw new Error('Grammar error: must have at least one rule.');
        }

        // use specified start symbol, or default to first user defined production
        this.startSymbol = grammar.start || grammar.startSymbol || this.productions[0].symbol;
        if (!this.nonterminals[this.startSymbol]) {
            throw new Error('Grammar error: startSymbol must be a non-terminal found in your grammar.');
        }
        this.EOF = '$end';

        // augment the grammar
        const acceptProduction = new Production('$accept', [this.startSymbol, '$end'], 0);
        this.productions.unshift(acceptProduction);

        // prepend parser tokens
        this.symbols.unshift('$accept', this.EOF);
        this.symbols_.$accept = 0;
        this.symbols_[this.EOF] = 1;
        this.terminals.unshift(this.EOF);

        this.nonterminals.$accept = new Nonterminal('$accept');
        this.nonterminals.$accept.productions.push(acceptProduction);

        // add follow $ to start symbol
        this.nonterminals[this.startSymbol].follows.push(this.EOF);

        if (this.DEBUG) {
            for (const [id, sym] of Object.entries(this.symbols)) {
                this.trace(`${sym}(${id})`)
            }
        }
    }

    buildProductions(bnf, productions, nonterminals, symbols, operators) {
        const actionGroups = Object.create(null);
        const productions_ = [0];
        const terminals = [];
        const terminals_ = Object.create(null);
        const symbols_ = Object.create(null);
        let symbolId = 1;
        let hasErrorRecovery = false; // has error recovery
        let actions = [
            '/* this == yyval */',
            this.actionInclude || '',
            'var $0 = $$.length - 1;',
            'switch (yystate) {'
        ];

        function addSymbol(s) {
            if (s === 'error') {
                hasErrorRecovery = true;
            }

            if (s && !symbols_[s]) {
                symbols_[s] = ++symbolId;
                symbols.push(s);
            }
        }

        // add error symbol; will be third symbol, or "2" ($accept, $end, error)
        addSymbol('error');
        hasErrorRecovery = false;

        for (const symbol of Object.keys(bnf)) {
            addSymbol(symbol);
            nonterminals[symbol] = new Nonterminal(symbol);

            const prods = typeof bnf[symbol] === 'string'
                ? bnf[symbol].split(/\s*\|\s*/g)
                : bnf[symbol].slice(0);

            for (const handle of prods) {
                const production = buildProduction(productions.length + 1, handle, symbol, addSymbol, actionGroups);

                // set precedence
                if (Array.isArray(handle)) {
                    const slotIdx = 1 + (typeof handle[1] === 'string' || handle.length == 3);

                    if (handle[slotIdx] && operators[handle[slotIdx].prec]) {
                        production.precedence = operators[handle[slotIdx].prec].precedence;
                    }
                }

                if (production.precedence === 0) {
                    for (const prodHandle of production.handle) {
                        if (prodHandle in nonterminals === false && prodHandle in operators) {
                            // FIXME: should it break on first se
                            production.precedence = operators[prodHandle].precedence;
                        }
                    }
                }

                // add to dicts
                nonterminals[symbol].productions.push(production);    
                productions.push(production);
                productions_.push([
                    symbols_[production.symbol],
                    production.handle[0] === '' ? 0 : production.handle.length
                ]);
            }
        }

        for (const action in actionGroups) {
            actions.push(actionGroups[action].join(' '), action, 'break;');
        }

        for (const [sym, id] of Object.entries(symbols_)) {
            if (sym in nonterminals === false) {
                terminals.push(sym);
                terminals_[id] = sym;
            }
        }

        this.hasErrorRecovery = hasErrorRecovery;
        this.terminals = terminals;
        this.terminals_ = terminals_;
        this.symbols_ = symbols_;
        this.productions_ = productions_;

        actions.push('}');
        actions = actions.join('\n')
            .replace(/YYABORT/g, 'return false')
            .replace(/YYACCEPT/g, 'return true');

        this.performAction = 'function(' + [
            'yytext',
            'yyleng',
            'yylineno',
            'yy',
            'yystate /* action[1] */',
            '$$ /* vstack */',
            '_$ /* lstack */',
            ...this.parseParams || []
        ] + ') {\n' + actions + '\n}';
    }

    createParser() {
        throw new Error('Calling abstract method.');
    }

    // noop. implemented in debug mixin
    trace(...args) {
        if (this.DEBUG) {
            Jison.print(...args);
        }
    }
    warn(...args) {
        Jison.print(...args);
    }
    error(msg) {
        throw new Error(msg);
    }
};

// set precedence and associativity of operators
function processOperators(ops) {
    const operators = Object.create(null);

    if (ops) {
        for (let i = 0, prec; prec = ops[i]; i++) {
            for (let k = 1; k < prec.length; k++) {
                operators[prec[k]] = {
                    precedence: i + 1,
                    assoc: prec[0]
                };
            }
        }
    }

    return operators;
}

/*
 * Lookahead parsers
 * */
class LookaheadGenerator extends Generator {
    computeLookaheads () {
        if (this.DEBUG) Object.assign(this, lookaheadDebug); // mixin debug methods
    
        this.computeLookaheads = () => {};
        this.nullableSets();
        this.firstSets();
        this.followSets();
    }

    // calculate follow sets typald on first and nullable
    followSets() {
        const { productions, nonterminals } = this;
        let cont = true;
    
        // loop until no further changes have been made
        while (cont) {
            cont = false;
    
            for (const production of productions) {
                // q is used in Simple LALR algorithm determine follows in context
                const ctx = this.go_;

                for (let i = 0, t; t = production.handle[i]; ++i) {
                    if (t in nonterminals === false) {
                        continue;
                    }

                    // for Simple LALR algorithm, this.go_ checks if
                    const bool = !ctx || this.nterms_[t] === this.go_(production.symbol, production.handle.slice(0, i));
                    let set;
    
                    if (i === production.handle.length + 1 && bool) {
                        set = nonterminals[production.symbol].follows;
                    } else {
                        set = this.first(production.handle, i + 1);

                        if (this.nullable(production.handle, i + 1) && bool) {
                            set.push(...nonterminals[production.symbol].follows);
                        }
                    }

                    if (addMissed(nonterminals[t].follows, set)) {
                        cont = true;
                    }
                }
            }
        }
    }

    // return the FIRST set of a symbol or series of symbols
    first(symbol, offset = 0) {
        // epsilon
        if (symbol === '') {
            return [];
        }

        // RHS
        if (Array.isArray(symbol)) {
            const firsts = new Set();

            for (let i = offset, t; t = symbol[i]; i++) {
                if (t in this.nonterminals) {
                    this.nonterminals[t].first.forEach(firsts.add, firsts);
                } else {
                    firsts.add(t);
                }

                if (!this.nullable(t)) {
                    break;
                }
            }

            return [...firsts];
        }
        
        // nonterminal
        if (symbol in this.nonterminals) {
            return this.nonterminals[symbol].first;
        }

        // terminal
        return [symbol];
    }

    // fixed-point calculation of FIRST sets
    firstSets() {
        const { productions, nonterminals } = this;
        let cont = true;

        // loop until no further changes have been made
        while (cont) {
            cont = false;
    
            for (const production of productions) {
                const firsts = this.first(production.handle);

                if (firsts.length !== production.first.length) {
                    production.first = firsts;
                    cont = true;
                }
            }
    
            for (const symbol of Object.keys(nonterminals)) {
                const firsts = new Set();

                for (const production of nonterminals[symbol].productions) {
                    production.first.forEach(firsts.add, firsts);
                }

                if (firsts.size !== nonterminals[symbol].first.length) {
                    nonterminals[symbol].first = [...firsts];
                    cont = true;
                }
            }
        }
    }

    // check if a token or series of tokens is nullable
    nullable(symbol, offset = 0) {
        // epsilon
        if (symbol === '') {
            return true;
        }

        // RHS
        if (Array.isArray(symbol)) {
            for (let i = offset; i < symbol.length; i++) {
                if (!this.nullable(symbol[i])) {
                    return false;
                }
            }

            return true;
        }
        
        // nonterminal
        if (symbol in this.nonterminals) {
            return this.nonterminals[symbol].nullable;
        }

        // terminal
        return false;
    }

    // fixed-point calculation of NULLABLE
    nullableSets() {
        let { productions, nonterminals } = this;
        let cont = true;
    
        // loop until no further changes have been made
        while (cont) {
            cont = false;
    
            // check if each production is nullable
            for (const production of productions) {
                if (!production.nullable) {
                    // production is nullable if all tokens are nullable
                    if (this.nullable(production.handle)) {
                        production.nullable = true;
                        cont = true;
                    }
                }
            }
    
            //check if each symbol is nullable
            for (const symbol in nonterminals) {
                if (!this.nullable(symbol)) {
                    for (const production of nonterminals[symbol].productions) {
                        if (production.nullable) {
                            nonterminals[symbol].nullable = true;
                            cont = true;
                        }
                    }
                }
            }
        }
    }
};

// lookahead debug mixin
var lookaheadDebug = {
    beforenullableSets() {
        this.trace("Computing Nullable sets.");
    },
    beforefirstSets() {
        this.trace("Computing First sets.");
    },
    beforefollowSets() {
        this.trace("Computing Follow sets.");
    },
    afterfollowSets() {
        for (const nt of Object.values(this.nonterminals)) {
            this.trace(nt);
        }
    }
};

/*
 * Mixin for common LR parser behavior
 * */
const NONASSOC = 0;
class LRGenerator extends LookaheadGenerator {
    buildTable() {
        if (this.DEBUG) Object.assign(this, lrGeneratorDebug); // mixin debug methods
    
        this.states = this.canonicalCollection();
        this.table = this.parseTable(this.states);
        this.defaultActions = findDefaults(this.table);
    }

    closureOperation(itemSet) {
        const { nonterminals } = this;
        const closureSet = new this.ItemSet(...itemSet);
    
        for (const item of closureSet) {
            const symbol = item.markedSymbol;
    
            // if token is a non-terminal, recursively add closures
            if (symbol in nonterminals) {
                for (const production of nonterminals[symbol].productions) {
                    closureSet.push(new this.Item(production, 0));
                }
            } else if (!symbol) {
                // reduction
                closureSet.reductions.push(item);
                closureSet.inadequate = closureSet.reductions.length > 1 || closureSet.shifts;
            } else {
                // shift
                closureSet.shifts = true;
                closureSet.inadequate = closureSet.reductions.length > 0;
            }
        }
    
        return closureSet;
    }

    gotoOperation(itemSet, symbol) {
        const gotoSet = new this.ItemSet();
    
        for (const item of itemSet) {
            if (item.markedSymbol === symbol) {
                gotoSet.push(new this.Item(item.production, item.dotPosition + 1, item.follows));
            }
        }
    
        return gotoSet.length === 0 ? gotoSet : this.closureOperation(gotoSet);
    }

    /* Create unique set of item sets
     * */
    canonicalCollection() {
        const firstItem = new this.Item(this.productions[0], 0, [this.EOF]);
        const firstState = this.closureOperation(new this.ItemSet(firstItem));
        const states = [firstState];

        states.has = Object.create(null);
        states.has[firstState] = 0;
    
        for (const itemSet of states) {
            for (const item of itemSet) {
                if (item.markedSymbol && item.markedSymbol !== this.EOF) {
                    this.canonicalCollectionInsert(itemSet, item.markedSymbol, states);
                }
            }
        }
    
        return states;
    }

    // Pushes a unique state into the que. Some parsing algorithms may perform additional operations
    canonicalCollectionInsert(itemSet, symbol, states) {
        const goto = this.gotoOperation(itemSet, symbol);

        // add goto to que if not empty or duplicate
        if (goto.length > 0) {
            const gotoId = goto.valueOf();
            
            if (gotoId in states.has) {
                itemSet.edges[symbol] = states.has[gotoId]; // store goto transition for table
            } else {
                itemSet.edges[symbol] = states.length; // store goto transition for table
                states.has[gotoId] = states.length;
                states.push(goto);
            }
        }
    }

    parseTable(itemSets) {
        const conflictedStates = []; // array of item index
    
        // for each item set
        const states = itemSets.map((itemSet, k) => {
            const state = Object.create(null);
    
            // set shift and goto actions
            for (const stackSymbol in itemSet.edges) {
                for (const item of itemSet) {
                    // find shift and goto actions
                    if (item.markedSymbol === stackSymbol) {
                        const gotoState = itemSet.edges[stackSymbol];

                        if (this.nonterminals[stackSymbol]) {
                            // store state to go to after a reduce
                            //this.trace(k, stackSymbol, 'g'+gotoState);
                            state[this.symbols_[stackSymbol]] = gotoState;
                        } else {
                            //this.trace(k, stackSymbol, 's'+gotoState);
                            state[this.symbols_[stackSymbol]] = [SHIFT, gotoState];
                        }
                    }
                }
            }
    
            // set accept action
            for (const item of itemSet) {
                if (item.markedSymbol === this.EOF) {
                    // accept
                    state[this.symbols_[this.EOF]] = [ACCEPT];
                }
            }
    
            // set reductions and resolve potential conflicts
            for (const reduction of itemSet.reductions) {
                // if parser uses lookahead, only enumerate those terminals
                const terminals = this.lookAheads
                    ? this.lookAheads(itemSet, reduction)
                    : this.terminals;
    
                for (const stackSymbol of terminals) {
                    let action = state[this.symbols_[stackSymbol]];
    
                    // Reading a terminal and current position is at the end of a production, try to reduce
                    if (action && action.length) {
                        const op = this.operators[stackSymbol];
                        const solution = resolveConflict(
                            reduction.production,
                            op,
                            [REDUCE, reduction.production.id],
                            Array.isArray(action[0]) ? action[0] : action
                        );

                        this.resolutions.push([k, stackSymbol, solution]);
                        if (solution.bydefault) {
                            this.conflicts++;

                            if (!this.DEBUG) {
                                conflictedStates.push(k);
                                this.warn(
                                    'Conflict in grammar: multiple actions possible when lookahead token is ',
                                    stackSymbol, ' in state ', k,
                                    "\n- ", printAction(solution.r, this),
                                    "\n- ", printAction(solution.s, this)
                                );
                            }

                            if (this.options.noDefaultResolve) {
                                if (!Array.isArray(action[0])) {
                                    action = [action];
                                }

                                action.push(solution.r);
                            }
                        } else {
                            action = solution.action;
                        }
                    } else {
                        action = [REDUCE, reduction.production.id];
                    }

                    if (action && action.length) {
                        state[this.symbols_[stackSymbol]] = action;
                    } else if (action === NONASSOC) {
                        state[this.symbols_[stackSymbol]] = undefined;
                    }
                }
            }

            return state;
        });
    
        if (!this.DEBUG && conflictedStates.length > 0) {
            this.warn('\nStates with conflicts:');
            for (const state in conflictedStates) {
                this.warn('State ' + state);
                this.warn('  ', itemSets[state].join("\n  "));
            }
        }
    
        return states;
    }

    parseError(str, hash) {
        if (hash.recoverable) {
            this.trace(str);
        } else {
            var error = new Error(str);
            error.hash = hash;
            throw error;
        }
    }

    generate(opt) {
        opt = { ...this.options, ...opt };
    
        // check for illegal identifier
        if (!opt.moduleName || !opt.moduleName.match(/^[A-Za-z_$][A-Za-z0-9_$]*$/)) {
            opt.moduleName = "parser";
        }

        switch (opt.moduleType) {
            case "js":
                return this.generateModule(opt);
            case "amd":
                return this.generateAMDModule(opt);
            default:
                return this.generateCommonJSModule(opt);
        }
    }

    generateAMDModule(){
        const module = this.generateModule_();
        let out = '\n\ndefine(function(require){\n'
            + module.commonCode
            + '\nvar parser = '+ module.moduleCode
            + "\n"+this.moduleInclude
            + (this.lexer && this.lexer.generateModule ?
              '\n' + this.lexer.generateModule() +
              '\nparser.lexer = lexer;' : '')
            + '\nreturn parser;'
            + '\n});'

        return out;
    }
    
    generateCommonJSModule(opt) {
        opt = { ...this.options, ...opt };

        const moduleName = opt.moduleName || "parser";
        let out = this.generateModule(opt)
            + "\n\n\nif (typeof require !== 'undefined' && typeof exports !== 'undefined') {"
            + "\nexports.parser = "+moduleName+";"
            + "\nexports.Parser = "+moduleName+".Parser;"
            + "\nexports.parse = function() { return "+moduleName+".parse.apply("+moduleName+", arguments); };"
            + "\nexports.main = "+ String(opt.moduleMain || commonjsMain) + ";"
            + "\nif (typeof module !== 'undefined' && require.main === module) {\n"
            + "  exports.main(process.argv.slice(1));\n}"
            + "\n}";
    
        return out;
    }
    
    generateModule(opt) {
        opt = { ...this.options, ...opt };

        const moduleName = opt.moduleName || "parser";
        let out = "/* parser generated by jison " + version + " */\n"
            + "/*\n"
            + "  Returns a Parser object of the following structure:\n"
            + "\n"
            + "  Parser: {\n"
            + "    yy: {}\n"
            + "  }\n"
            + "\n"
            + "  Parser.prototype: {\n"
            + "    yy: {},\n"
            + "    trace(),\n"
            + "    symbols_: {associative list: name ==> number},\n"
            + "    terminals_: {associative list: number ==> name},\n"
            + "    productions_: [...],\n"
            + "    performAction(yytext, yyleng, yylineno, yy, yystate, $$, _$),\n"
            + "    table: [...],\n"
            + "    defaultActions: {...},\n"
            + "    parseError(str, hash),\n"
            + "    parse(input),\n"
            + "\n"
            + "    lexer: {\n"
            + "        EOF: 1,\n"
            + "        parseError(str, hash),\n"
            + "        setInput(input),\n"
            + "        input(),\n"
            + "        unput(str),\n"
            + "        more(),\n"
            + "        less(n),\n"
            + "        pastInput(),\n"
            + "        upcomingInput(),\n"
            + "        showPosition(),\n"
            + "        test_match(regex_match_array, rule_index),\n"
            + "        next(),\n"
            + "        lex(),\n"
            + "        begin(condition),\n"
            + "        popState(),\n"
            + "        _currentRules(),\n"
            + "        topState(),\n"
            + "        pushState(condition),\n"
            + "\n"
            + "        options: {\n"
            + "            ranges: boolean           (optional: true ==> token location info will include a .range[] member)\n"
            + "            flex: boolean             (optional: true ==> flex-like lexing behaviour where the rules are tested exhaustively to find the longest match)\n"
            + "            backtrack_lexer: boolean  (optional: true ==> lexer regexes are tested in order and for each matching regex the action code is invoked; the lexer terminates the scan when a token is returned by the action code)\n"
            + "        },\n"
            + "\n"
            + "        performAction(yy, yy_, $avoiding_name_collisions, YY_START),\n"
            + "        rules: [...],\n"
            + "        conditions: {associative list: name ==> set},\n"
            + "    }\n"
            + "  }\n"
            + "\n"
            + "\n"
            + "  token location info (@$, _$, etc.): {\n"
            + "    first_line: n,\n"
            + "    last_line: n,\n"
            + "    first_column: n,\n"
            + "    last_column: n,\n"
            + "    range: [start_number, end_number]       (where the numbers are indexes into the input string, regular zero-based)\n"
            + "  }\n"
            + "\n"
            + "\n"
            + "  the parseError function receives a 'hash' object with these members for lexer and parser errors: {\n"
            + "    text:        (matched text)\n"
            + "    token:       (the produced terminal token, if any)\n"
            + "    line:        (yylineno)\n"
            + "  }\n"
            + "  while parser (grammar) errors will also provide these members, i.e. parser errors deliver a superset of attributes: {\n"
            + "    loc:         (yylloc)\n"
            + "    expected:    (string describing the set of expected tokens)\n"
            + "    recoverable: (boolean: TRUE when the parser has a error recovery rule available for this particular error)\n"
            + "  }\n"
            + "*/\n";
        out += (moduleName.match(/\./) ? moduleName : "var " + moduleName)
            + " = " + this.generateModuleExpr();
    
        return out;
    }
    
    generateModuleExpr() {
        const module = this.generateModule_();
        let out = '';
    
        out += "(function(){\n";
        out += module.commonCode;
        out += "\nvar parser = " + module.moduleCode;
        out += "\n" + this.moduleInclude;

        if (this.lexer && this.lexer.generateModule) {
            out += this.lexer.generateModule();
            out += "\nparser.lexer = lexer;";
        }

        out += "\nfunction Parser() {\n  this.yy = {};\n}\n"
            + "Parser.prototype = parser;"
            + "parser.Parser = Parser;"
            + "\nreturn new Parser;\n})();";
    
        return out;
    }

    // Generates the code of the parser module, which consists of two parts:
    // - module.commonCode: initialization code that should be placed before the module
    // - module.moduleCode: code that creates the module object
    generateModule_() {
        var parseFn = String(parser.parse);

        if (!this.hasErrorRecovery) {
            parseFn = removeErrorRecovery(parseFn);
        }

        if (this.options['token-stack']) {
            parseFn = addTokenStack(parseFn);
        }

        // Generate code with fresh variable names
        nextVariableId = 0;
        var tableCode = this.generateTableCode(this.table);

        // Generate the initialization code
        var commonCode = tableCode.commonCode;

        // Generate the module creation code
        var moduleCode = "{";
        moduleCode += [
            "trace: " + String(this.trace || parser.trace).replace(/^\s*trace\(/, 'function('),
            "yy: {}",
            "symbols_: " + JSON.stringify(this.symbols_),
            "terminals_: " + JSON.stringify(this.terminals_).replace(/"(\d+)":/g,"$1:"),
            "productions_: " + JSON.stringify(this.productions_),
            "performAction: " + String(this.performAction),
            "table: " + tableCode.moduleCode,
            "defaultActions: " + JSON.stringify(this.defaultActions).replace(/"(\d+)":/g,"$1:"),
            "parseError: " + String(this.parseError || (this.hasErrorRecovery ? traceParseError : parser.parseError)).replace(/^\s*parseError\(/, 'function('),
            "parse: " + parseFn
        ].join(",\n");
        moduleCode += "};";

        return { commonCode, moduleCode }
    }

    // Generate code that represents the specified parser table
    generateTableCode(table) {
        const variables = [createObjectCode];
        let moduleCode = JSON.stringify(table);

        // Don't surround numerical property name numbers in quotes
        moduleCode = moduleCode.replace(/"(\d+)"(?=:)/g, "$1");

        // Replace objects with several identical values by function calls
        // e.g., { 1: [6, 7]; 3: [6, 7], 4: [6, 7], 5: 8 } = o([1, 3, 4], [6, 7], { 5: 8 })
        moduleCode = moduleCode.replace(/\{\d+:[^\}]+,\d+:[^\}]+\}/g, function(object) {
            // Find the value that occurs with the highest number of keys
            var value, frequentValue, key, keys = {}, keyCount, maxKeyCount = 0,
                keyValue, keyValues = [], keyValueMatcher = /(\d+):([^:]+)(?=,\d+:|\})/g;

            while (keyValue = keyValueMatcher.exec(object)) {
                // For each value, store the keys where that value occurs
                key = keyValue[1];
                value = keyValue[2];
                keyCount = 1;

                if (value in keys) {
                    keyCount = keys[value].push(key);
                } else {
                    keys[value] = [key];
                }

                // Remember this value if it is the most frequent one
                if (keyCount > maxKeyCount) {
                    maxKeyCount = keyCount;
                    frequentValue = value;
                }
            }

            // Construct the object with a function call if the most frequent value occurs multiple times
            if (maxKeyCount > 1) {
                // Collect all non-frequent values into a remainder object
                for (value in keys) {
                    if (value !== frequentValue) {
                        for (var k = keys[value], i = 0, l = k.length; i < l; i++) {
                            keyValues.push(k[i] + ':' + value);
                        }
                    }
                }
                keyValues = keyValues.length ? ',{' + keyValues.join(',') + '}' : '';
                // Create the function call `o(keys, value, remainder)`
                object = 'o([' + keys[frequentValue].join(',') + '],' + frequentValue + keyValues + ')';
            }

            return object;
        });

        // Count occurrences of number lists
        var list;
        var lists = {};
        var listMatcher = /\[[0-9,]+\]/g;

        while (list = listMatcher.exec(moduleCode)) {
            lists[list] = (lists[list] || 0) + 1;
        }

        // Replace frequently occurring number lists with variables
        moduleCode = moduleCode.replace(listMatcher, function(list) {
            var listId = lists[list];
            // If listId is a number, it represents the list's occurrence frequency
            if (typeof listId === 'number') {
                // If the list does not occur frequently, represent it by the list
                if (listId === 1) {
                    lists[list] = listId = list;
                // If the list occurs frequently, represent it by a newly assigned variable
                } else {
                    lists[list] = listId = createVariable();
                    variables.push(listId + '=' + list);
                }
            }
            return listId;
        });

        // Return the variable initialization code and the table code
        return {
            commonCode: 'var ' + variables.join(',') + ';',
            moduleCode
        };
    }

    createParser() {
        var p = eval(this.generateModuleExpr());

        // for debugging
        p.productions = this.productions;

        var self = this;
        function bind(method) {
            return function() {
                self.lexer = p.lexer;
                return self[method].apply(self, arguments);
            };
        }

        // backwards compatability
        p.lexer = this.lexer;
        p.generate = bind('generate');
        p.generateAMDModule = bind('generateAMDModule');
        p.generateModule = bind('generateModule');
        p.generateCommonJSModule = bind('generateCommonJSModule');

        return p;
    }
};

LRGenerator.prototype.Item = class {
    constructor(production, dotPosition = 0, follows = []) {
        this.production = production;
        this.dotPosition = dotPosition;
        this.follows = follows;
        this.id = production.id + 'a' + this.dotPosition;
        this.markedSymbol = production.handle[this.dotPosition];
    }
    eq(e) {
        return e.id === this.id;
    }
    handleToString() {
        const handle = this.production.handle.slice(0);
        handle[this.dotPosition] = '.' + (handle[this.dotPosition] || '');
        return handle.join(' ');
    }
    toString() {
        return this.production.symbol + " -> " + this.handleToString() +
            (this.follows.length === 0 ? "" : " #lookaheads= " + this.follows.join(' '));
    }
}

LRGenerator.prototype.ItemSet = class extends Array {
    static get [Symbol.species]() { return Array; }

    constructor(...args) {
        super(...args);
        this.ids_ = new Set(this.map(item => item.id));
        this.reductions = [];
        this.goes = Object.create(null);
        this.edges = Object.create(null);
        this.shifts = false;
        this.inadequate = false;
    }
    push(...items) {
        for (const item of items) {
            if (!this.contains(item)) {
                this.ids_.add(item.id);
                super.push(item);
            }
        }

        return this.length;
    }
    contains(item) {
        return this.ids_.has(item.id);
    }
    valueOf() {
        return [...this.ids_].sort().join('|');
    }
}

// find states with only one action, a reduction
function findDefaults(states) {
    const defaults = Object.create(null);

    states.forEach(function(state, k) {
        const [act, ...rest] = Object.keys(state);

        if (rest.length === 0 && state[act][0] === 2) {
            // only one action in state and it's a reduction
            defaults[k] = state[act];
        }
    });

    return defaults;
}

// resolves shift-reduce and reduce-reduce conflicts
function resolveConflict(production, op, reduce, shift) {
    var solution = { production, operator: op, r: reduce, s: shift };

    if (shift[0] === REDUCE) {
        solution.msg = "Resolve R/R conflict (use first production declared in grammar.)";
        solution.action = shift[1] < reduce[1] ? shift : reduce;

        if (shift[1] !== reduce[1]) {
            solution.bydefault = true;
        }

        return solution;
    }

    if (production.precedence === 0 || !op) {
        solution.msg = "Resolve S/R conflict (shift by default.)";
        solution.bydefault = true;
        solution.action = shift;
    } else if (production.precedence < op.precedence ) {
        solution.msg = "Resolve S/R conflict (shift for higher precedent operator.)";
        solution.action = shift;
    } else if (production.precedence === op.precedence) {
        if (op.assoc === "right") {
            solution.msg = "Resolve S/R conflict (shift for right associative operator.)";
            solution.action = shift;
        } else if (op.assoc === "left") {
            solution.msg = "Resolve S/R conflict (reduce for left associative operator.)";
            solution.action = reduce;
        } else if (op.assoc === "nonassoc") {
            solution.msg = "Resolve S/R conflict (no action for non-associative operator.)";
            solution.action = NONASSOC;
        }
    } else {
        solution.msg = "Resolve conflict (reduce for higher precedent production.)";
        solution.action = reduce;
    }

    return solution;
}

// lex function that supports token stacks
function tokenStackLex() {
    let token = tstack.pop() || lexer.lex() || EOF;

    // if token isn't its numeric value, convert
    if (typeof token !== 'number') {
        if (Array.isArray(token)) {
            tstack = token;
            token = tstack.pop();
        }

        token = self.symbols_[token] || token;
    }

    return token;
}

function addTokenStack(fn) {
    return fn.replace(/\/\*\* @replace token stack \*\/(.|\s)+?\/\*\* @replace \*\//, String(tokenStackLex));
}

// returns parse function without error recovery code
function removeErrorRecovery(fn) {
    return fn.replace(/\/\*\* @cut recovery \*\/.+/g, '');
}

// Function that extends an object with the given value for all given keys
// e.g., o([1, 3, 4], [6, 7], { x: 1, y: 2 }) = { 1: [6, 7]; 3: [6, 7], 4: [6, 7], x: 1, y: 2 }
var createObjectCode = 'o=function(k,v,o,l){' +
    'for(o=o||{},l=k.length;l--;o[k[l]]=v);' +
    'return o}';

// Creates a variable with a unique name
function createVariable() {
    var id = nextVariableId++;
    var name = '$V';

    do {
        name += variableTokens[id % variableTokensLength];
        id = Math.floor(id / variableTokensLength);
    } while (id !== 0);

    return name;
}

var nextVariableId = 0;
var variableTokens = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
var variableTokensLength = variableTokens.length;

// default main method for generated commonjs modules
function commonjsMain(args) {
    if (!args[1]) {
        console.log('Usage: '+args[0]+' FILE');
        process.exit(1);
    }
    var source = require('fs').readFileSync(require('path').normalize(args[1]), "utf8");
    return exports.parser.parse(source);
}

// debug mixin for LR parser generators

function printAction(a, gen) {
    switch (a[0]) {
        case 1: return `shift token (then go to state ${a[1]})`;
        case 2: return `reduce by rule: ${gen.productions[a[1]]}`;
        default:
            return 'accept';
    }
}

var lrGeneratorDebug = {
    beforeparseTable() {
        this.trace("Building parse table.");
    },
    afterparseTable() {
        var self = this;
        if (this.conflicts > 0) {
            this.resolutions.forEach(function(r, i) {
                if (r[2].bydefault) {
                    self.warn('Conflict at state: ',r[0], ', token: ',r[1], "\n  ", printAction(r[2].r, self), "\n  ", printAction(r[2].s, self));
                }
            });
            this.trace("\n"+this.conflicts+" Conflict(s) found in grammar.");
        }
        this.trace("Done.");
    },
    aftercanonicalCollection(states) {
        var trace = this.trace;
        trace("\nItem sets\n------");

        states.forEach(function(state, i) {
            trace("\nitem set",i,"\n"+state.join("\n"), '\ntransitions -> ', JSON.stringify(state.edges));
        });
    }
};

function traceParseError(err, hash) {
    this.trace(err);
}

var parser = {};

parser.trace = Generator.prototype.trace;
parser.warn = Generator.prototype.warn;
parser.error = Generator.prototype.error;
parser.parseError = LRGenerator.prototype.parseError;
parser.parse = function parse(input) {
    var self = this,
        stack = [0],
        tstack = [], // token stack
        vstack = [null], // semantic value stack
        lstack = [], // location stack
        table = this.table,
        yytext = '',
        yylineno = 0,
        yyleng = 0,
        recovering = 0,
        TERROR = 2,
        EOF = 1;

    var args = lstack.slice.call(arguments, 1);

    //this.reductionCount = this.shiftCount = 0;

    var lexer = Object.create(this.lexer);
    var sharedState = { yy: { ...this.yy } }; // copy state

    lexer.setInput(input, sharedState.yy);
    sharedState.yy.lexer = lexer;
    sharedState.yy.parser = this;
    if (typeof lexer.yylloc == 'undefined') {
        lexer.yylloc = {};
    }
    var yyloc = lexer.yylloc;
    lstack.push(yyloc);

    var ranges = lexer.options && lexer.options.ranges;

    if (typeof sharedState.yy.parseError === 'function') {
        this.parseError = sharedState.yy.parseError;
    } else {
        this.parseError = Object.getPrototypeOf(this).parseError;
    }

    function popStack(n) {
        stack.length = stack.length - 2 * n;
        vstack.length = vstack.length - n;
        lstack.length = lstack.length - n;
    }

    var lex = /** @replace token stack */ function() {
        var token;
        token = lexer.lex() || EOF;
        // if token isn't its numeric value, convert
        if (typeof token !== 'number') {
            token = self.symbols_[token] || token;
        }
        return token;
    } /** @replace */

    var symbol, preErrorSymbol, state, action, r, yyval = {}, p, len, newState, expected;
    while (true) {
        // retreive state number from top of stack
        state = stack[stack.length - 1];

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
        if (typeof action === 'undefined' || !action.length || !action[0]) {
            var error_rule_depth;
            var errStr = '';

            // Return the rule stack depth where the nearest error rule can be found.
            // Return FALSE when no error recovery rule was found.
            function locateNearestErrorRecoveryRule(state) {
                let stack_probe = stack.length - 1;
                let depth = 0;

                // try to recover from error
                while (true) {
                    // check for error recovery rule in this state
                    if (TERROR.toString() in table[state]) {
                        return depth;
                    }

                    if (state === 0 || stack_probe < 2) {
                        return false; // No suitable error recovery rule available.
                    }

                    stack_probe -= 2; // popStack(1): [symbol, action]
                    state = stack[stack_probe];
                    ++depth;
                }
            }

            if (!recovering) {
                // first see if there's any chance at hitting an error recovery rule:
                /** @cut recovery */error_rule_depth = locateNearestErrorRecoveryRule(state);

                // Report error
                expected = [];
                for (p in table[state]) {
                    if (this.terminals_[p] && p > TERROR) {
                        expected.push("'"+this.terminals_[p]+"'");
                    }
                }

                if (lexer.showPosition) {
                    errStr = 'Parse error on line '+(yylineno+1)+":\n"+lexer.showPosition()+"\nExpecting "+expected.join(', ') + ", got '" + (this.terminals_[symbol] || symbol)+ "'";
                } else {
                    errStr = 'Parse error on line '+(yylineno+1)+": Unexpected " +
                                  (symbol == EOF ? "end of input" :
                                              ("'"+(this.terminals_[symbol] || symbol)+"'"));
                }
                this.parseError(errStr, {
                    text: lexer.match,
                    token: this.terminals_[symbol] || symbol,
                    line: lexer.yylineno,
                    loc: yyloc,
                    expected: expected,
                    /** @cut recovery */recoverable: (error_rule_depth !== false)
                });
            } else if (preErrorSymbol !== EOF) {
                error_rule_depth = locateNearestErrorRecoveryRule(state);
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
                yyloc = lexer.yylloc;
                symbol = lex();
            }

            // try to recover from error
            if (error_rule_depth === false) {
                throw new Error(errStr || 'Parsing halted. No suitable error recovery rule available.');
            }
            popStack(error_rule_depth);

            preErrorSymbol = (symbol == TERROR ? null : symbol); // save the lookahead token
            symbol = TERROR;         // insert generic error symbol as new lookahead
            state = stack[stack.length-1];
            action = table[state] && table[state][TERROR];
            recovering = 3; // allow 3 real symbols to be shifted before reporting a new error
        }

        // this shouldn't happen, unless resolve defaults are off
        if (Array.isArray(action[0]) && action.length > 1) {
            throw new Error('Parse Error: multiple actions possible at state: '+state+', token: '+symbol);
        }

        switch (action[0]) {
            case 1: // shift
                //this.shiftCount++;

                stack.push(symbol);
                vstack.push(lexer.yytext);
                lstack.push(lexer.yylloc);
                stack.push(action[1]); // push state
                symbol = null;

                if (!preErrorSymbol) { // normal execution/no error
                    yyleng = lexer.yyleng;
                    yytext = lexer.yytext;
                    yylineno = lexer.yylineno;
                    yyloc = lexer.yylloc;
                    if (recovering > 0) {
                        recovering--;
                    }
                } else {
                    // error just occurred, resume old lookahead f/ before error
                    symbol = preErrorSymbol;
                    preErrorSymbol = null;
                }

                break;

            case 2: // reduce
                //this.reductionCount++;

                len = this.productions_[action[1]][1];

                // perform semantic action
                yyval.$ = vstack[vstack.length-len]; // default to $$ = $1
                // default location, uses first token for firsts, last for lasts
                yyval._$ = {
                    first_line: lstack[lstack.length-(len||1)].first_line,
                    last_line: lstack[lstack.length-1].last_line,
                    first_column: lstack[lstack.length-(len||1)].first_column,
                    last_column: lstack[lstack.length-1].last_column
                };

                if (ranges) {
                  yyval._$.range = [lstack[lstack.length-(len||1)].range[0], lstack[lstack.length-1].range[1]];
                }

                r = this.performAction.apply(yyval, [yytext, yyleng, yylineno, sharedState.yy, action[1], vstack, lstack].concat(args));

                if (typeof r !== 'undefined') {
                    return r;
                }

                // pop off stack
                if (len) {
                    stack = stack.slice(0, -1 * len * 2);
                    vstack = vstack.slice(0, -1 * len);
                    lstack = lstack.slice(0, -1 * len);
                }

                stack.push(this.productions_[action[1]][0]);    // push nonterminal (reduce)
                vstack.push(yyval.$);
                lstack.push(yyval._$);
                // goto new state = table[STATE][NONTERMINAL]
                newState = table[stack[stack.length-2]][stack[stack.length-1]];
                stack.push(newState);
                break;

            case 3: // accept
                return true;
        }
    }
};

/*
 * LR(0) Parser
 * */

class LR0Generator extends LRGenerator {
    get type() {
        return 'LR(0)';
    }
    constructor(...args) {
        super(...args);
        this.buildTable();
    }
};

exports.LR0Generator = LR0Generator;

/*
 * Simple LALR(1)
 * */

class LALRGenerator extends LRGenerator {
    get type() {
        return 'LALR(1)';
    }

    constructor(grammar, options) {
        super(grammar, options);

        if (this.DEBUG) Object.assign(this, lrGeneratorDebug, lalrGeneratorDebug); // mixin debug methods

        options = options || {};
        this.states = this.canonicalCollection();
        this.terms_ = Object.create(null);
        this.inadequateStates = [];

        this.newg = Object.assign(Object.create(LookaheadGenerator.prototype), {
            DEBUG: false,
            trace: this.trace,
            nterms_: Object.create(null),
            nonterminals: Object.create(null),
            productions: [],
            go_: (r, B) => {
                // console.log(r, B);
                r = r.split(':')[0]; // grab state #
                B = B.map(b => b.slice(b.indexOf(':') + 1));

                let q = parseInt(r, 10);
        
                for (const ref of B) {
                    q = this.states[q].edges[ref] || q;
                }
        
                return q;
            }
        });

        // if true, only lookaheads in inadequate states are computed (faster, larger table)
        // if false, lookaheads for all reductions will be computed (slower, smaller table)
        this.onDemandLookahead = options.onDemandLookahead || false;

        this.buildNewGrammar();
        this.newg.computeLookaheads();
        this.unionLookaheads();

        this.table = this.parseTable(this.states);
        this.defaultActions = findDefaults(this.table);
    }

    lookAheads(state, item) {
        return this.onDemandLookahead && !state.inadequate
            ? this.terminals
            : item.follows;
    }

    goPath(p, w) {
        const path = [];
        let q = parseInt(p, 10);

        for (const ref of w) {
            const t = ref ? q + ":" + ref : '';

            if (t) {
                this.newg.nterms_[t] = q;
            }

            path.push(t);
            this.terms_[t] = ref;
            q = this.states[q].edges[ref] || q;
        }
        return { path, endState: q };
    }

    // every disjoint reduction of a nonterminal becomes a production in G'
    buildNewGrammar() {
        const newg = this.newg;

        this.states.forEach((state, i) => {
            for (const item of state) {
                if (item.dotPosition === 0) {
                    // new symbols are a combination of state and transition symbol
                    const symbol = i + ':' + item.production.symbol;

                    this.terms_[symbol] = item.production.symbol;
                    newg.nterms_[symbol] = i;

                    if (symbol in newg.nonterminals === false) {
                        newg.nonterminals[symbol] = new Nonterminal(symbol);
                    }

                    const pathInfo = this.goPath(i, item.production.handle);
                    const production = new Production(symbol, pathInfo.path, newg.productions.length);

                    newg.productions.push(production);
                    newg.nonterminals[symbol].productions.push(production);

                    // store the transition that get's 'backed up to' after reduction on path
                    const handle = item.production.handle.join(' ');
                    const goes = this.states[pathInfo.endState].goes;

                    if (handle in goes) {
                        goes[handle].push(symbol);
                    } else {
                        goes[handle] = [symbol];
                    }
                }
            }

            if (state.inadequate) {
                this.inadequateStates.push(state);
            }
        });
    }

    unionLookaheads() {
        const states = this.onDemandLookahead
                ? this.inadequateStates
                : this.states;

        for (const state of states) {
            for (const reduction of state.reductions) {
                var follows = new Set(reduction.follows);

                for (const goesSymbol of state.goes[reduction.production.handle.join(' ')]) {
                    for (const followSymbol of this.newg.nonterminals[goesSymbol].follows) {
                        var terminal = this.terms_[followSymbol];

                        if (!follows.has(terminal)) {
                            follows.add(terminal);
                            reduction.follows.push(terminal);
                        }
                    }
                }
            }
        }
    }
}

exports.LALRGenerator = LALRGenerator;

// LALR generator debug mixin

var lalrGeneratorDebug = {
    trace() {
        Jison.print.apply(null, arguments);
    },
    beforebuildNewGrammar() {
        this.trace(this.states.length + ' states.');
        this.trace('Building lookahead grammar.');
    },
    beforeunionLookaheads() {
        this.trace('Computing lookaheads.');
    }
};

/*
 * Lookahead parser definitions
 *
 * Define base type
 * */
class LRLookaheadGenerator extends LRGenerator {
    constructor(...args) {
        super(...args);
        this.computeLookaheads();
        this.buildTable();
    }
}

/*
 * SLR Parser
 * */
class SLRGenerator extends LRLookaheadGenerator {
    get type() {
        return 'SLR(1)';
    }
    lookAheads(_, item) {
        return this.nonterminals[item.production.symbol].follows;
    }
};
exports.SLRGenerator = SLRGenerator;

/*
 * LR(1) Parser
 * */
class LR1Generator extends LRLookaheadGenerator {
    get type() {
        return 'Canonical LR(1)';
    }

    lookAheads(_, item) {
        return item.follows;
    }

    closureOperation(itemSet) {
        const { nonterminals } = this;
        const closureSet = new this.ItemSet(...itemSet);

        for (const item of closureSet) {
            var symbol = item.markedSymbol;

            // if token is a nonterminal, recursively add closures
            if (symbol in nonterminals) {
                const follows = this.first(item.production.handle, item.dotPosition + 1);

                if (follows.length === 0 || item.production.nullable || this.nullable(item.production.handle, item.dotPosition + 1)) {
                    follows.push(...item.follows);
                }

                for (const production of nonterminals[symbol].productions) {
                    closureSet.push(new this.Item(production, 0, follows));
                }
            } else if (!symbol) {
                // reduction
                closureSet.reductions.push(item);
            }
        }

        return closureSet;
    }
};

LR1Generator.prototype.Item = class extends LRGenerator.prototype.Item {
    constructor(...args) {
        super(...args);
        this.id = `${this.production.id}a${this.dotPosition}a${this.follows.sort().join(',')}`;
    }
};

exports.LR1Generator = LR1Generator;

/*
 * LL Parser
 * */
class LLGenerator extends LookaheadGenerator {
    get type() {
        return 'LL(1)';
    }

    constructor(...args) {
        super(...args);
        this.computeLookaheads();
        this.table = this.parseTable(this.productions);
    }

    parseTable(productions) {
        const table = Object.create(null);

        productions.forEach((production, i) => {
            const row = table[production.symbol] || Object.create(null);
            const tokens = production.first;

            if (this.nullable(production.handle)) {
                tokens.push(...this.nonterminals[production.symbol].follows);
            }

            for (const token of tokens) {
                if (token in row) {
                    row[token].push(i);
                    this.conflicts++;
                } else {
                    row[token] = [i];
                }
            }

            table[production.symbol] = row;
        });

        return table;
    }
};

exports.LLGenerator = LLGenerator;
