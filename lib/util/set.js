// Set class to wrap arrays

class Set {
    static union(a, b) {
        var ar = {};
        for (var k=a.length-1;k >=0;--k) {
            ar[a[k]] = true;
        }
        for (var i=b.length-1;i >= 0;--i) {
            if (!ar[b[i]]) {
                a.push(b[i]);
            }
        }
        return a;
    }

    constructor(set, raw) {
        if (Array.isArray(set)) {
            this._items = raw ? set : set.slice(0);
        } else {
            this._items = arguments.length 
                ? [].slice.call(arguments, 0)
                : [];
        }
    }
    concat(setB) {
        this._items.push.apply(this._items, setB._items || setB); 
        return this;
    }
    eq(set) {
        return this._items.length === set._items.length && this.subset(set); 
    }
    indexOf(item) {
        if(item && item.eq) {
            for(var k=0; k<this._items.length;k++)
                if(item.eq(this._items[k]))
                    return k;
            return -1;
        }
        return this._items.indexOf(item);
    }
    union(set) {
        return (new Set(this._items)).concat(this.complement(set));
    }
    intersection(set) {
        return this.filter(function (elm) {
            return set.contains(elm);
        });
    }
    complement(set) {
        return set.filter(elm => !this.contains(elm));
    }
    subset(set) {
        var cont = true;
        for (var i=0; i<this._items.length && cont;i++) {
            cont = cont && set.contains(this._items[i]);
        }
        return cont;
    }
    superset(set) {
        return set.subset(this);
    }
    joinSet(set) {
        return this.concat(this.complement(set));
    }
    contains(item) { return this.indexOf(item) !== -1; }
    item(v) { return this._items[v]; }
    i(v) { return this._items[v]; }
    first() { return this._items[0]; }
    last() { return this._items[this._items.length-1]; }
    size() { return this._items.length; }
    isEmpty() { return this._items.length === 0; }
    copy() { return new Set(this._items); }
    toString() { return this._items.toString(); }
};

"push shift unshift forEach some every join sort".split(' ').forEach(function (e) {
    Set.prototype[e] = function () { return Array.prototype[e].apply(this._items, arguments); };
});
"filter slice map".split(' ').forEach(function (e) {
    Set.prototype[e] = function () { return new Set(Array.prototype[e].apply(this._items, arguments), true); };
});

module.exports = Set;
