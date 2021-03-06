// This is the runner that runs from node.js to execute the tests
import { getBundle } from './server';
import { extractFunctionNames, formatLine, getElapsedTime, looksTheSame, spaces, PREFIX } from './util';
import { syntaxHighlight } from './highlight';
import Queue from './classes/Queue';
import ProgressBar from 'progress';
import chalk from 'chalk';

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
export async function singleRun(options) {
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

function groupLines(string) {
    const bits = string.split(new RegExp(`^${PREFIX.results}`, 'gm'));
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

export async function runTests(options) {
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
