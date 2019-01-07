#!/usr/bin/env node
/* Luna v1.1.1 */
'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var chalk = _interopDefault(require('chalk'));
var ProgressBar = _interopDefault(require('progress'));

const constant = /\b(\d+|true|false)\b/g;
const operator = /\+|\!|\-|&|>|<|\||\*|\=/g;
const string = /('|"|`)([\s\S]*?)(\1)/g;
const commentLine = /\/\/(.*)/g;
const commentMultiline = /\/\*([\s\S]*?)\*\//g;
const escapedStringChars = /\\('|"|`)/g;

// Prefixes for log communication messages
const PREFIX = {
    running: '__LunaRunning__',
    finished: '__LunaFinished__',
    results: '__LunaResults__',
    coverage: '__LunaCoverage__'
};

function extractFunctionNames(source) {
    source = source.replace(escapedStringChars, '');
    source = source.replace(string, '__STRING__');
    source = source.replace(commentLine, '');
    source = source.replace(commentMultiline, '');

    const re = /export(?: async)?\s+function\s+(test.*?)\(/g;
    let match;
    const names = [];
    while ((match = re.exec(source))) {
        names.push(match[1]);
    }

    return names;
}

function getElapsedTime(startTime, endTime) {
    const elapsed = endTime / 1000 - startTime / 1000;
    const minutes = Math.floor(elapsed / 60);
    const seconds = Math.round((elapsed - (minutes * 60)) * 100) / 100;

    let response = '';
    if (minutes > 0) {
        response += `${minutes} minute${minutes !== 1 ? 's' : ''}, `;
    }

    if (seconds < 1 && minutes > 0) {
        return response.slice(0, -2);
    }

    response += `${seconds} second${seconds !== 1 ? 's' : ''}`;
    return response;
}

function spaces(count) {
    let str = '';
    for (let i = 0; i < count; i++) {
        str += ' ';
    }
    return str;
}

function formatLine(number, width) {
    let numberString = number.toString();
    let numberWidth = numberString.length;
    while (numberWidth < width) {
        numberString = ` ${numberString}`;
        numberWidth += 1;
    }

    return numberString;
}

function looksTheSame(first, second) {
    // change unquoted object properties to quoted
    first = first.replace(/([{,]\s*)(.+?):/g, (match, group1, group2) => `${group1}"${group2}":`);

    try {
        const parsedFirst = JSON.parse(first);
        return JSON.stringify(parsedFirst) === JSON.stringify(second);
    } catch (e) {
        return false;
    }
}
/* eslint-enable complexity, brace-style */

function findLineAndColumnForPosition(code, index) {
    const lines = code.split('\n');
    let pos = 0;
    let lastPos = 0;
    let line = 0;
    let column = 0;
    while (pos < index) {
        const nextLine = lines.shift();
        line += 1;
        lastPos = pos;
        pos += nextLine.length + 1; // 1 for the \n
    }

    // If there is nothing to loop over
    if (line === 0) {
        line = 1;
    }

    column += (index - lastPos);
    return { line, column };
}

const esprima = require('esprima');
const escodegen = require('escodegen');
const MagicString = require('magic-string');

const escodegenOptions = {
    format: {
        indent: {
            style: ''
        },
        newline: '',
        json: true
    }
};

function getData(assertCode, file, position) {
    const ast = esprima.parse(assertCode, { tolerant: true, range: true });
    const args = ast.body[0].expression.arguments;

    const isBinaryExpression = args[0].type === 'BinaryExpression';
    const leftExpression = isBinaryExpression ? args[0].left : args[0];

    const data = {
        source: {
            code: assertCode,
            file,
            position
        },
        left: {
            code: escodegen.generate(leftExpression, escodegenOptions),
            value: '{{LEFT_VALUE}}',
            range: leftExpression.range
        },
        value: '{{VALUE}}'
    };

    if (isBinaryExpression) {
        data.operator = args[0].operator;
        data.right = {
            code: escodegen.generate(args[0].right, escodegenOptions),
            value: '{{RIGHT_VALUE}}',
            range: args[0].right.range
        };
    }

    if (args.length > 1 && args[1].type === 'Literal') {
        data.message = args[1].value;
    }

    return data;
}

function getReplacement(assertCode, file, position, index) {
    const data = getData(assertCode, file, position);
    let newCode = `\n    const _left${index} = ${data.left.code};`;
    let value = `_left${index}`;
    if (data.right) {
        newCode += `\n    const _right${index} = ${data.right.code};`;
        value += ` ${data.operator} _right${index}`;
    }

    let dataString = JSON.stringify(data);

    dataString = dataString.replace('"{{LEFT_VALUE}}"', `_left${index}`);
    dataString = dataString.replace('"{{RIGHT_VALUE}}"', `_right${index}`);
    dataString = dataString.replace('"{{VALUE}}"', value);

    newCode += `\n    t.assert(${dataString}`;
    if (data.message) {
        newCode += `, ${JSON.stringify(data.message)}`;
    }
    newCode += ');';

    return newCode;
}

function transform(code, id) {
    const re = /((?:\/\/|\/\*|['"`])\s*)?\bt\.assert\(.*?\);?(?=\r?\n)/g;
    let match;
    let start;
    let end;
    let hasReplacements = false;

    const magicString = new MagicString(code);

    let i = 0;
    while ((match = re.exec(code))) {
        if (match[1]) {
            continue;
        }

        i += 1;
        hasReplacements = true;

        start = match.index;
        end = start + match[0].length;

        const position = findLineAndColumnForPosition(code, start);
        const replacement = getReplacement(match[0], id, position, i);

        magicString.overwrite(start, end, replacement);
    }

    if (!hasReplacements) {
        return null;
    }

    return {
        code: magicString.toString(),
        map: magicString.generateMap({ hires: true })
    };
}

function assert() {
    return {
        name: 'assert',
        transform(code, id) {
            return transform(code, id);
        }
    };
}

const path = require('path');
const rollup = require('rollup');
const replace = require('rollup-plugin-replace');
const coverage = require('rollup-plugin-istanbul');

async function getBundle(filePath, options) {
    return new Promise(async(resolve, reject) => {
        try {
            // This is somewhat confusing, but on Windows since this is a
            // straight string replacement any path that has \test\something in
            // it will end up rendering the \t as a tab characters. We have to
            // make sure that any \ are replaced with \\
            const fullTestPath = path.join(process.cwd(), filePath).replace(/\\/g, '\\\\');
            const mainDir = path.dirname(require.main.filename);
            // ../../../ => /node_modules/luna-testing/bin
            const mainResolve = (p) => path.resolve(mainDir, '../../../', p);
            const config = require(mainResolve('services/cli/scripts/config'));
            const configPlugins = config.getBuild('ui-server-dev').plugins;

            const plugins = [
                replace({
                    TEST_FILE_PATH: fullTestPath,
                    TEST_TIMEOUT: options.timeout
                }),
                assert()
            ].concat(configPlugins);

            if (options.coverage) {
                plugins.push(coverage({
                    exclude: [filePath, 'node_modules/**']
                }));
            }

            const bundle = await rollup.rollup({
                input: path.resolve(`${__dirname}/../src`, 'run-node.js'),
                external: ['chalk'],
                treeshake: true,
                plugins
            });

            /* eslint-disable prefer-const */
            let { code, map } = await bundle.generate({
                format: 'cjs',
                freeze: true,
                sourcemap: 'inline'
            });
            /* eslint-enable prefer-const */

            code += `\n//# sourceMappingURL=${map.toUrl()}\n`;
            resolve(code);
        } catch (e) {
            reject(e);
        }
    });
}

function syntaxHighlight(code) {
    const strings = [];
    const stringMap = {};

    if (code === undefined) {
        return chalk.yellow('undefined');
    }

    code = code.replace(string, (match) => {
        const stringName = `__STRING__${strings.length}`;
        strings.push(stringName);
        stringMap[stringName] = match;
        return stringName;
    });

    code = code.replace(operator, (match) => chalk.magenta(match));
    code = code.replace(constant, (match) => chalk.yellow(match));

    for (const stringName of strings) {
        code = code.replace(stringName, chalk.green(stringMap[stringName]));
    }

    return code;
}

/**
 * Ripple is a simple event manager that adds on, off, and fire events to any
 * object.
 *
 * @type {Object}
 */
const ripple = {
    wrap: (obj) => {
        const callbacks = {};

        obj.on = function(eventName, callback) {
            if (!callbacks[eventName]) {
                callbacks[eventName] = [];
            }

            callbacks[eventName].push(callback);
        };

        obj.off = function(eventName, callback) {
            if (callback === undefined) {
                delete callbacks[eventName];
                return;
            }

            const index = callbacks[eventName].indexOf(callback);
            callbacks[eventName].splice(index, 1);
        };

        obj.fire = function(...args) {
            const eventName = args[0];
            if (callbacks[eventName]) {
                for (let i = 0, len = callbacks[eventName].length, cb; i < len; i++) {
                    cb = callbacks[eventName][i];
                    cb.apply(obj, args.slice(1));
                }
            }
        };
    }
};

class Task {
    constructor(fn, name) {
        this.fn = fn;
        this.name = name;
    }
}

class Queue {
    constructor({ concurrency = 1 } = {}) {
        this.tasks = [];
        this.running = false;
        this.concurrency = concurrency;
        this._active = [];
        ripple.wrap(this);
    }

    addTask(task, name) {
        if (!(task instanceof Promise)) {
            throw new Error('Task needs to be a promise!');
        }

        this.tasks.push(new Task(task, name));
    }

    _markComplete(eventName, toRun, response) {
        this.fire(eventName, toRun.name, response);
        const index = this._active.indexOf(toRun);
        this._active.splice(index, 1);
        this._run();
    }

    _run() {
        if (!this.running) {
            return;
        }

        if (this.tasks.length === 0 && this._active.length === 0) {
            this.fire('complete');
            return;
        }

        while (this._active.length < this.concurrency && this.tasks.length > 0) {
            const toRun = this.tasks.shift();
            this._active.push(toRun);

            this.fire('taskstart', toRun.name);
            toRun.fn.then((response) => {
                this._markComplete('taskend', toRun, response);
            }).catch((e) => {
                this._markComplete('taskerror', toRun, e);
            });
        }
    }

    start() {
        this.running = true;
        this.fire('start');
        this._run();
    }

    stop() {
        this.running = false;
        this.fire('stop');
    }
}

// This is the runner that runs from node.js to execute the tests

const fs = require('fs');
const spawn = require('child_process').spawn;
const walk = require('walk');
const istanbul = require('istanbul-lib-coverage');
const createReporter = require('istanbul-api').createReporter;

let bar;
const logs = [];
const map = istanbul.createCoverageMap();
const coveragePaths = [];

function getTestCount(path) {
    const contents = fs.readFileSync(path);
    return extractFunctionNames(contents.toString()).length;
}

async function getFilesToRun(path, options) {
    return new Promise((resolve, reject) => {
        path = path.replace(/\/+$/g, '');
        const stats = fs.lstatSync(path);
        const paths = [];
        let count = 0;
        if (stats.isFile()) {
            resolve({ paths: [path], count: getTestCount(path) });
            return;
        }

        const walker = walk.walk(path);
        walker.on('file', (root, fileStats, next) => {
            const newPath = `${root}/${fileStats.name}`;
            const testCount = getTestCount(newPath);

            if (options.verbose && testCount === 0) {
                console.log(`File: ${newPath} does not export any tests! Skipping…`);
            }

            if (testCount > 0) {
                paths.push(newPath);
                count += testCount;
            }
            next();
        });

        walker.on('errors', (root, nodeStatsArray, next) => {
            next();
        });

        walker.on('end', () => {
            resolve({ paths, count });
        });
    });
}


// This is called from the new node thread that is launched to run tests when
// runing natively in node
//
// @see https://stackoverflow.com/questions/17581830/load-node-js-module-from-string-in-memory
async function singleRun(options) {
    function requireFromString(src, filename) {
        const m = new module.constructor();
        m.paths = module.paths;
        m._compile(src, filename);
        return m.exports;
    }

    const testPath = options.paths[0];
    const code = await getBundle(testPath, options);
    const tests = requireFromString(code, '');
    return tests.run();
}

function handleMessage(message, testPath, options) {
    if (new RegExp(`^${PREFIX.running}`).test(message)) {
        return false;
    }

    if (new RegExp(`^${PREFIX.finished}`).test(message)) {
        if (!options.verbose) {
            bar.tick();
            return false;
        }

        const messageBits = message.split(' ');
        const failures = parseInt(messageBits[2], 10);
        console.log(`${failures === 0 ? chalk.green.bold('✔︎') : chalk.red.bold('𝗫')}  ${chalk.gray(`[${testPath}]`)}`, messageBits[1]);
        return false;
    }

    if (new RegExp(`^${PREFIX.results}`).test(message)) {
        return JSON.parse(message.split(`${PREFIX.results} `)[1]);
    }

    if (new RegExp(`^${PREFIX.coverage}`).test(message)) {
        const coverageFile = message.split(`${PREFIX.coverage} `)[1];
        coveragePaths.push(coverageFile);
        return false;
    }

    if (message) {
        logs.push(message);
    }

    return false;
}

function groupLines(string$$1) {
    const bits = string$$1.split(new RegExp(`^${PREFIX.results}`, 'gm'));
    const lines = bits[0].split('\n');
    if (bits[1]) {
        lines.push(`${PREFIX.results} ${bits[1]}`);
    }

    return lines;
}

async function runTestNode(testPath, options) {
    return new Promise((resolve, reject) => {
        // console.log('runTestNode', testPath, options);

        // On Mac and Linux the path to the executable is enough because it can
        // resolve #!/usr/bin/env node to execute it, but on Windows that
        // doesn’t work. Here we have to prepend the luna executable to the
        // args.
        const args = [options.binary, testPath, '--node', '--single-run', '--timeout', options.timeout];
        if (!options.coverage) {
            args.push('-x');
        }

        const test = spawn(process.execPath, args);
        let results = {};
        test.stdout.on('data', (output) => {
            const lines = groupLines(output.toString());
            for (const line of lines) {
                results = handleMessage(line, testPath, options);
            }
        });

        test.stderr.on('data', (output) => {
            reject(output.toString());
        });

        test.on('close', () => {
            resolve(results);
        });
    });
}

function killWithError(message) {
    if (message) {
        console.log(`⚠️  ${chalk.bold(message)}`);
    }
    process.exit(1);
}

function logAssertion(testData) {
    const lineNumber = testData.source.position.line;
    const lineWidth = (lineNumber + 2).toString().length;

    const indent = spaces(4);
    console.log(`\n${chalk.yellow(formatLine(lineNumber - 1, lineWidth))}`);
    console.log(`${chalk.yellow(formatLine(lineNumber, lineWidth))} ${indent}${syntaxHighlight(testData.source.code)}`);
    let leftIndex = testData.left.range[0];

    // Move it to after the last dot
    if (testData.left.code.indexOf('.') !== -1) {
        const bits = testData.left.code.split('.');
        bits.pop();
        leftIndex += bits.join('.').length + 1;
    }
    let rightIndex = -1;

    if (testData.right) {
        rightIndex = testData.right.range[0];
        if (looksTheSame(testData.right.code, testData.right.value)) {
            rightIndex = -1;
        }
    }

    if (leftIndex > -1) {
        console.log(`${chalk.yellow(formatLine(lineNumber + 1, lineWidth))} ${indent}${spaces(leftIndex)}${chalk.gray('|')}${rightIndex > -1 ? spaces(rightIndex - leftIndex - 1) + chalk.gray('|') : ''}`);
        if (rightIndex > -1) {
            console.log(`${spaces(lineWidth)} ${indent}${spaces(leftIndex)}${chalk.gray('|')}${rightIndex > -1 ? spaces(rightIndex - leftIndex - 1) + syntaxHighlight(JSON.stringify(testData.right.value)) : ''}`);
        }
        console.log(`${spaces(lineWidth)} ${indent}${spaces(leftIndex)}${syntaxHighlight(JSON.stringify(testData.left.value))}\n`);
    }
}

function logError(error, options) {
    console.log(`\n${chalk.bold.underline(error.name)}\n`);
    if (error.type === 'taskerror') {
        console.log(`⚠️  ${chalk.red(error.data)}\n`);
        return;
    }

    for (const test of error.data) {
        if (test.failures === 0) {
            continue;
        }

        console.log(`❌  ${chalk.red.bold(test.name)}`);
        if (test.data) {
            logAssertion(test.data);
            continue;
        }

        if (test.trace) {
            console.log(`\n⚠️  ${test.trace}\n`);
        }
    }
}

function logErrors(tests, options) {
    const errors = [];
    let failures = 0;
    for (const test of tests) {
        // console.log(test);
        if (test.type === 'taskerror') {
            errors.push(test);
            continue;
        }

        for (const result of test.data) {
            if (result.failures > 0) {
                failures += result.failures;
                if (errors.indexOf(test) === -1) {
                    errors.push(test);
                }
            }
        }
    }

    if (errors.length === 0) {
        console.log('💯  All tests passed!');
        return 0;
    }

    if (failures > 0) {
        if (options.fastFail) {
            console.log('');
        }

        console.log(`💔  ${failures} test${failures !== 1 ? 's' : ''} failed!`);
    }

    for (const error of errors) {
        logError(error, options);
    }

    return 1;
}

function logLogs(exitCode) {
    if (logs.length === 0) {
        return;
    }

    // If we are good an extra line before the console logs
    if (exitCode === 0) {
        console.log('');
    }

    console.log(chalk.bold.underline.blue('Console Logs\n'));
    for (const log of logs) {
        console.log(log);
    }
    console.log('');
}

function logCoverage(options) {
    if (!options.coverage) {
        return;
    }

    for (const path of coveragePaths) {
        try {
            const coverage = fs.readFileSync(path);
            fs.unlinkSync(path);
            map.merge(JSON.parse(coverage));
        } catch (e) {
            // Empty
        }
    }

    // This is how to get the complete list of uncovered lines
    // map.files().forEach(function (f) {
    //     var fc = map.fileCoverageFor(f);
    //     console.log(f, fc.getUncoveredLines());
    // });

    const reporter = createReporter();
    const reportersToUse = ['lcov', 'text-summary'];
    if (options.verbose) {
        console.log('');
        reportersToUse.splice(1, 0, 'text');
    }
    reporter.addAll(reportersToUse);
    reporter.write(map);

    console.log(`\n💾  HTML coverage report available at ${chalk.bold.underline('coverage/lcov-report/index.html')}`);
}

async function runTests(options) {
    const startTime = new Date().getTime();

    const q = new Queue({
        concurrency: options.concurrency
    });

    let files = [];
    let totalTests = 0;
    for (const path of options.paths) {
        const { paths, count } = await getFilesToRun(path, options);
        files = files.concat(paths);
        totalTests += count;
    }

    if (totalTests === 0) {
        let pathsForError = files;
        if (files.length === 0) {
            pathsForError = options.paths;
        }
        killWithError(`There were no tests exported by: ${pathsForError.join(', ')}`);
        return;
    }

    console.log('🌙  Running tests…');
    if (!options.verbose) {
        bar = new ProgressBar('⏳  [:bar] :percent (:current/:total)', {
            total: totalTests,
            width: 50,
            renderThrottle: 0,
            callback: () => {
                // console.log('progress bar callback');
                // process.stderr.write('\x1B[?25h');
            }
        });

        // process.stderr.write('\x1B[?25l')
    }

    for (const filePath of files) {
        q.addTask(runTestNode(filePath, options), filePath);
    }

    // q.on('start', () => {
    //     console.log('start');
    // })

    // q.on('taskstart', (name) => {
    //     console.log('taskstart', name);
    // })

    const results = [];

    async function handleComplete() {
        const exitCode = logErrors(results, options);

        const endTime = new Date().getTime();

        logLogs(exitCode);
        logCoverage(options);

        console.log(`⚡️  Took ${getElapsedTime(startTime, endTime)}`);

        process.exit(exitCode);
    }

    q.on('taskend', (name, data) => {
        // console.log('taskend', name, data);
        results.push({
            type: 'taskend',
            name,
            data
        });

        const failures = data.reduce((a, b) => a + b.failures, 0);

        if (options.fastFail && failures > 0) {
            handleComplete();
        }
    });

    q.on('taskerror', (name, data) => {
        // console.log('taskerror', name, data);
        results.push({
            type: 'taskerror',
            name,
            data
        });

        if (options.fastFail) {
            handleComplete();
        }
    });

    q.on('complete', handleComplete);
    q.start();
}

const fs$1 = require('fs');
const yargs = require('yargs');
const os = require('os');
const path$1 = require('path');
const version = require('./../package.json').version;
const ci = require('ci-info');

function showUsage(message) {
    console.log([
        '            ',
        '     ,/   * ',
        `  _,'/_   |          Luna v${version}`,
        '  \`(")\' ,\'/'].join('\n'));
    console.log('\n\x1B[1mUSAGE\x1B[0m');
    console.log('luna /path/to/tests');
    console.log('\n\x1B[1mOPTIONS\x1B[0m');
    console.log('-c, --concurrency    Number of test files to run at a time (default: 1)');
    console.log('-f, --fast-fail      Fail immediately after a test failure');
    console.log('-x, --no-coverage    Disable code coverage');
    console.log('-t, --timeout        Maximum time in seconds to wait for async tests to complete (default: 5)');
    console.log('-p, --port           Port to run webserver on (default: 5862)');
    console.log('-i, --inject         JavaScript file(s) to inject into the page');
    console.log('-h, --help           Show usage');
    console.log('-v, --verbose        Show verbose output when tests run');
    console.log('--version            Show version');

    if (message) {
        console.log(`\n⚠️  ${chalk.bold(message)}`);
    }
}

// Override default help
const argv = yargs
    .alias('h', 'help')
    .alias('v', 'verbose')
    .alias('c', 'concurrency')
    .alias('f', 'fast-fail')
    .alias('x', 'no-coverage')
    .alias('p', 'port')
    .alias('t', 'timeout')
    .alias('i', 'inject')
    .help('').argv;

if (argv.help) {
    showUsage();
    process.exit(0);
}

if (argv._.length < 1) {
    showUsage('No test path specified\n');
    process.exit(1);
}

const paths = [];
for (let i = 0; i < argv._.length; i++) {
    if (fs$1.existsSync(argv._[i])) {
        paths.push(argv._[i]);
    }
}

if (paths.length === 0) {
    showUsage('No files found at provided paths');
    process.exit(1);
}

// yargv tries to be too smart and when you prefix a flag with --no-{flagName}
// it automatically sets the result to {flagName}: false which was not what I
// was expecting. This makes sure that if the flag is set to false the other
// value comes in too.
if (argv.coverage === false) {
    argv.noCoverage = true;
}

const options = {
    paths,
    binary: argv.$0,
    coverage: !argv.noCoverage,
    concurrency: argv.concurrency || 1,
    port: argv.port || 5862,
    verbose: argv.verbose,
    inject: argv.inject,
    singleRun: argv['single-run'],
    fastFail: argv['fast-fail'],
    timeout: argv.timeout || 5
};

// Force verbose mode from a CI environment
if (ci.isCI) {
    options.verbose = true;
}

(async() => {
    try {
        if (options.singleRun) {
            // There is a limitation on how much output can be captured from a
            // child process:
            //
            // @see https://github.com/nodejs/node/issues/19218
            let fileName;
            const hasCoverage = options.coverage;
            if (hasCoverage) {
                fileName = path$1.join(os.tmpdir(), `coverage-${process.pid}.json`);
                console.log(PREFIX.coverage, fileName);
            }

            await singleRun(options);

            /* global __coverage__ */
            if (hasCoverage && typeof __coverage__ !== 'undefined') {
                fs$1.writeFileSync(fileName, JSON.stringify(__coverage__));
            }
            process.exit(0);
            return;
        }
        await runTests(options);
    } catch (e) {
        console.error('Error running tests', e);
        process.exit(1);
    }
})();
