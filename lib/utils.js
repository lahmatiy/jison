module.exports.fnBody = function(fn) {
    return String(fn)
        .replace(/^\s*(?:function\s*\([^)]*\)|(?:\([^)]*\)|\S+)\s*=>)\s*\{\s*(?:\n|\r\n?)/, '')
        .replace(/\s*\}\s*$/, '');
};
