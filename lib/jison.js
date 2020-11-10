// Jison, an LR(0), SLR(1), LARL(1), LR(1) Parser Generator
// Zachary Carter <zach@carter.name>
// MIT X Licensed

const Lexer = require('./lexer');
const ebnfParser = require('ebnf-parser');
const parse = require('./parse');
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

/*
 * Mixin for common LR parser behavior
 * */
const NONASSOC = 0;
class LRGenerator extends LookaheadGenerator {
    buildTable() {
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
                                    "\n- ", printAction(solution.reduce, this),
                                    "\n- ", printAction(solution.shift, this)
                                );
                            }

                            if (this.options.noDefaultResolve) {
                                if (!Array.isArray(action[0])) {
                                    action = [action];
                                }

                                action.push(solution.reduce);
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
            const error = new Error(str);
            error.hash = hash;
            throw error;
        }
    }
    
    generateModule(opt) {
        opt = { ...this.options, ...opt };

        const moduleName = opt.moduleName || "parser";
        let out = "/* parser generated by jison " + version + " */\n"
            + (moduleName.match(/\./) ? moduleName : 'var ' + moduleName)
            + ' = (function(){\n'
            + this.generateModuleExpr()
            + '\nconst parser = new Parser;'
            + '\nif (typeof module !== "undefined" && typeof exports === "object") module.exports = exports = parser'
            + '\nreturn parser;'
            + '\n})()';
    
        return out;
    }
    
    generateModuleExpr() {
        const module = this.generateModule_();
        let out = '';
    
        out += module.commonCode;
        out += "\nconst parserPrototype = " + module.moduleCode;
        out += "\n" + this.moduleInclude;

        if (this.lexer && this.lexer.generateModule) {
            out += this.lexer.generateModule();
            out += "\nparserPrototype.lexer = lexer;";
        }

        out += "\nfunction Parser() {\n  this.yy = {};\n}\n"
            + "Parser.prototype = parserPrototype;"
            + "parserPrototype.Parser = Parser;";
    
        return out;
    }

    // Generates the code of the parser module, which consists of two parts:
    // - module.commonCode: initialization code that should be placed before the module
    // - module.moduleCode: code that creates the module object
    generateModule_() {
        let parseSource = String(parse);

        if (!this.hasErrorRecovery) {
            parseSource = removeErrorRecovery(parseSource);
        }

        if (this.options['token-stack']) {
            parseSource = addTokenStack(parseSource);
        }

        // Generate code with fresh variable names
        const tableCode = this.generateTableCode(this.table);

        // Generate the initialization code
        const commonCode = tableCode.commonCode;

        // Generate the module creation code
        const moduleCode = '{' + [
            'trace: ' + String(this.trace).replace(/^\s*trace\(/, 'function('),
            'yy: {}',
            'symbols_: ' + JSON.stringify(this.symbols_),
            'terminals_: ' + JSON.stringify(this.terminals_).replace(/"(\d+)":/g, '$1:'),
            'productions_: ' + JSON.stringify(this.productions_),
            'performAction: ' + String(this.performAction),
            'table: ' + tableCode.moduleCode,
            'defaultActions: ' + JSON.stringify(this.defaultActions).replace(/"(\d+)":/g, '$1:'),
            'parseError: ' + String(this.parseError || (this.hasErrorRecovery ? traceParseError : this.parseError)).replace(/^\s*parseError\(/, 'function('),
            'parse: ' + parseSource
        ].join(',\n') + '};';

        return { commonCode, moduleCode }
    }

    // Generate code that represents the specified parser table
    generateTableCode(table) {
        // Function that extends an object with the given value for all given keys
        // e.g., o([1, 3, 4], [6, 7], { x: 1, y: 2 }) = { 1: [6, 7]; 3: [6, 7], 4: [6, 7], x: 1, y: 2 }
        const createObjectCode = 'o=' + function(keys, v, o = {}){
            keys.forEach(key => o[key] = v);
            return o;
        };

        const variables = [createObjectCode];
        let moduleCode = JSON.stringify(table);

        // Don't surround numerical property name numbers in quotes
        moduleCode = moduleCode.replace(/"(\d+)"(?=:)/g, '$1');

        // Replace objects with several identical values by function calls
        // e.g., { 1: [6, 7]; 3: [6, 7], 4: [6, 7], 5: 8 } = o([1, 3, 4], [6, 7], { 5: 8 })
        moduleCode = moduleCode.replace(/\{\d+:[^\}]+,\d+:[^\}]+\}/g, function(object) {
            // Find the value that occurs with the highest number of keys
            const keyValueMatcher = /(\d+):([^:]+)(?=,\d+:|\})/g;
            const keys = Object.create(null);
            let keyValueMatch;
            let frequentValue;
            let maxKeyCount = 0;

            while (keyValueMatch = keyValueMatcher.exec(object)) {
                // For each value, store the keys where that value occurs
                const [, key, value] = keyValueMatch;
                let keyCount;

                if (value in keys) {
                    keyCount = keys[value].push(key);
                } else {
                    keys[value] = [key];
                    keyCount = 1;
                }

                // Remember this value if it is the most frequent one
                if (keyCount > maxKeyCount) {
                    maxKeyCount = keyCount;
                    frequentValue = value;
                }
            }

            // Construct the object with a function call if the most frequent value occurs multiple times
            if (maxKeyCount > 1) {
                const keyValues = [];

                // Collect all non-frequent values into a remainder object
                for (const value in keys) {
                    if (value !== frequentValue) {
                        for (const key of keys[value]) {
                            keyValues.push(key + ':' + value);
                        }
                    }
                }

                // Create the function call `o(keys, value, remainder)`
                object = `o([${keys[frequentValue]}],${frequentValue}${keyValues.length ? ',{' + keyValues + '}' : ''})`;
            }

            return object;
        });

        // Count occurrences of number lists
        let list;
        let lists = Object.create(null);
        let listMatcher = /\[[0-9,]+\]/g;
        let varNameSeed = 0;
        const createVariable = () => '$V' + varNameSeed++;

        while (list = listMatcher.exec(moduleCode)) {
            lists[list] = (lists[list] || 0) + 1;
        }

        // Replace frequently occurring number lists with variables
        moduleCode = moduleCode.replace(listMatcher, list => {
            let listId = lists[list];

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
        const parser = Function(this.generateModuleExpr() + 'return new Parser;')();

        // backwards compatability
        parser.lexer = this.lexer;
        parser.generateModule = (...args) => {
            this.lexer = parser.lexer;
            return this.generateModule(...args);
        };

        return parser;
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
        return this.production.symbol + ' -> ' + this.handleToString() +
            (this.follows.length === 0 ? '' : ' #lookaheads= ' + this.follows.join(' '));
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
function resolveConflict(production, operator, reduce, shift) {
    const solution = {
        production,
        operator,
        reduce,
        shift
    };

    if (shift[0] === REDUCE) {
        solution.msg = "Resolve R/R conflict (use first production declared in grammar.)";
        solution.action = shift[1] < reduce[1] ? shift : reduce;

        if (shift[1] !== reduce[1]) {
            solution.bydefault = true;
        }

        return solution;
    }

    if (production.precedence === 0 || !operator) {
        solution.msg = "Resolve S/R conflict (shift by default.)";
        solution.bydefault = true;
        solution.action = shift;
    } else if (production.precedence < operator.precedence ) {
        solution.msg = "Resolve S/R conflict (shift for higher precedent operator.)";
        solution.action = shift;
    } else if (production.precedence === operator.precedence) {
        if (operator.assoc === "right") {
            solution.msg = "Resolve S/R conflict (shift for right associative operator.)";
            solution.action = shift;
        } else if (operator.assoc === "left") {
            solution.msg = "Resolve S/R conflict (reduce for left associative operator.)";
            solution.action = reduce;
        } else if (operator.assoc === "nonassoc") {
            solution.msg = "Resolve S/R conflict (no action for non-associative operator.)";
            solution.action = NONASSOC;
        }
    } else {
        solution.msg = "Resolve conflict (reduce for higher precedent production.)";
        solution.action = reduce;
    }

    return solution;
}

function addTokenStack(fn) {
    // replace lex function for that supports token stacks
    return fn.replace(/\/\*\* @replace token stack \*\/(.|\s)+?\/\*\* @replace \*\//, String(() => {
        let token = tstack.pop() || lexer.lex() || EOF;
    
        // if token isn't its numeric value, convert
        if (typeof token !== 'number') {
            if (Array.isArray(token)) {
                tstack = token;
                token = tstack.pop();
            }
    
            token = this.symbols_[token] || token;
        }
    
        return token;
    }));
}

// returns parse function without error recovery code
function removeErrorRecovery(fn) {
    return fn.replace(/\/\*\* @cut recovery \*\/.+/g, '');
}

function printAction(a, gen) {
    switch (a[0]) {
        case 1: return `shift token (then go to state ${a[1]})`;
        case 2: return `reduce by rule: ${gen.productions[a[1]]}`;
        default:
            return 'accept';
    }
}

function traceParseError(err, hash) {
    this.trace(err);
}

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
                let q = parseInt(r.split(':')[0]); // grab state #
                B = B.map(b => b.slice(b.indexOf(':') + 1));
        
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
                    const handle = item.production.id;
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
                const follows = new Set(reduction.follows);

                for (const goesSymbol of state.goes[reduction.production.id]) {
                    for (const followSymbol of this.newg.nonterminals[goesSymbol].follows) {
                        const terminal = this.terms_[followSymbol];

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
            const symbol = item.markedSymbol;

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
