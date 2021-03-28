const lexParser = require('lex-parser');

module.exports = {
    processGrammar
};

function prepareRules(rules, startConditions, flex) {
    if (flex) {
        rules = rules.concat([['.', '']]);
    }

    return rules.map((rule, i) => {
        rule = rule.slice();

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

        return rule;
    });
}

// expand macros within macros and produce a substitute function
// FIXME: infinite loop is possible
function buildMacrosSubstituteFn(macros) {
    const macrosNoParentsRx = new RegExp('\\{(' + Object.keys(macros).join('|') + ')\\}(?![?+*{])', 'g');
    const macrosRx = new RegExp('\\{(' + Object.keys(macros).join('|') + ')\\}', 'g');
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

    return pattern => pattern
        .replace(macrosNoParentsRx, (_, ref) => macros[ref])
        .replace(macrosRx, (_, ref) => '(' + macros[ref] + ')');
}

function preparePatterns(rules, macros, caseless) {
    const substituteMacros = macros ? buildMacrosSubstituteFn(macros) : pattern => pattern;

    return rules.map(rule => {
        let pattern = rule[0];

        if (typeof pattern === 'string') {
            pattern = substituteMacros(pattern);
            pattern = new RegExp(
                pattern.includes('|') ? '^(?:' + pattern + ')' : '^' + pattern,
                caseless ? 'i' : ''
            );
        }

        return pattern;
    });
}

function prepareStartConditions(conditions) {
    const result = {};

    for (const [key, value] of Object.entries(conditions || {})) {
        result[key] = {
            rules: [],
            inclusive: !value
        };
    }

    return result;
}

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
    opts.moduleInclude = (dict.moduleInclude || '').trim();

    opts.tokens = tokens;
    opts.conditions = prepareStartConditions(dict.startConditions);
    opts.conditions.INITIAL = { rules: [], inclusive: true };
    opts.conditionStack = ['INITIAL'];
    opts.actionInclude = dict.actionInclude;
    opts.rules = prepareRules(
        dict.rules,
        opts.conditions,
        dict.options && dict.options.flex
    );
    opts.patterns = preparePatterns(
        opts.rules,
        dict.macros,
        opts.options['case-insensitive']
    );

    return opts;
}
