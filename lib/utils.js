module.exports.fnBody = function(fn) {
    return String(fn)
        .replace(/^\s*(?:function\s*\([^)]*\)\s*\{\s*(?:\n|\r\n?)?|(?:\([^)]*\)|\S+)\s*=>\s*\{?\s*(?:\n|\r\n?)?)/, '')
        .replace(/\s*\}\s*$/, '');
};
