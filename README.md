Jison (remastered)
==================

[![NPM version](https://img.shields.io/npm/v/@lahmatiy/jison.svg)](https://www.npmjs.com/package/@lahmatiy/jison)
[![Build Status](https://travis-ci.org/lahmatiy/jison.svg?branch=master)](https://travis-ci.org/lahmatiy/jison)

That's a fork of [Jison](http://github.com/zaach/jison) parser generator by [Zach Carter](http://github.com/zaach/).

The difference:

- Removed web site sources
- Removed CLI & bundling. Those things may back in the future but in fresh way
- Removed generator methods except `generateModule`
- Refactored to use ES6+ features, remove redundant abstractions, minor bug fixes
- Features:
    - Added support for function patterns in lexer

-------------

An API for creating parsers in JavaScript
-----------------------------------------

Jison generates bottom-up parsers in JavaScript. Its API is similar to Bison's, hence the name. It supports many of Bison's major features, plus some of its own. If you are new to parser generators such as Bison, and Context-free Grammars in general, a [good introduction][1] is found in the Bison manual. If you already know Bison, Jison should be easy to pickup.

Briefly, Jison takes a JSON encoded grammar or Bison style grammar and outputs a JavaScript file capable of parsing the language described by that grammar. You can then use the generated script to parse inputs and accept, reject, or perform actions based on the input.

## Installation

```
    npm install @lahmatiy/jison
```

## Usage

```javascript
// mygenerator.js
const { Parser } = require('jison');

// a grammar in JSON
const grammar = {
    lex: {
        rules: [
           ['\\s+', '/* skip whitespace */'],
           ['[a-f0-9]+', 'return "HEX";']
        ]
    },

    bnf: {
        hex_strings: [
            'hex_strings HEX', 'HEX'
        ]
    }
};

// `grammar` can also be a string that uses jison's grammar format
const parser = new Parser(grammar);

// now you can use the parser directly from memory
// returns true
parser.parse("adfe34bc e82a");

// throws lexical error
parser.parse("adfe34bc zxg");

// ... or generate source code of parser
const parserSource = parser.generateModule();
```

More Documentation
------------------
For more information on creating grammars and using the generated parsers, read the [documentation](http://jison.org/docs).

How to contribute
-----------------

See [CONTRIBUTING.md](https://github.com/zaach/jison/blob/master/CONTRIBUTING.md) for contribution guidelines, how to run the tests, etc.

Projects using Jison
------------------

View them on the [wiki](https://github.com/zaach/jison/wiki/ProjectsUsingJison), or add your own.

Contributors
------------
[Githubbers](http://github.com/zaach/jison/contributors)

Special thanks to Jarred Ligatti, Manuel E. Bermúdez 

## License

> Copyright (c) 2009-2014 Zachary Carter
> 
>  Permission is hereby granted, free of
> charge, to any person  obtaining a
> copy of this software and associated
> documentation  files (the "Software"),
> to deal in the Software without 
> restriction, including without
> limitation the rights to use,  copy,
> modify, merge, publish, distribute,
> sublicense, and/or sell  copies of the
> Software, and to permit persons to
> whom the  Software is furnished to do
> so, subject to the following 
> conditions:
> 
>  The above copyright notice and this
> permission notice shall be  included
> in all copies or substantial portions
> of the Software.
> 
>  THE SOFTWARE IS PROVIDED "AS IS",
> WITHOUT WARRANTY OF ANY KIND,  EXPRESS
> OR IMPLIED, INCLUDING BUT NOT LIMITED
> TO THE WARRANTIES  OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND 
> NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT  HOLDERS BE
> LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY,  WHETHER IN AN ACTION OF
> CONTRACT, TORT OR OTHERWISE, ARISING 
> FROM, OUT OF OR IN CONNECTION WITH THE
> SOFTWARE OR THE USE OR  OTHER DEALINGS
> IN THE SOFTWARE.


  [1]: http://dinosaur.compilertools.net/bison/bison_4.html

