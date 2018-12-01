const path = require('path');
const rollup = require('rollup');
const buble = require('rollup-plugin-buble');
const replace = require('rollup-plugin-replace');
const coverage = require('rollup-plugin-istanbul');
import assert from './rollup-assert';

export async function getBundle(filePath, options) {
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
            const morePlugins = require(mainResolve('rollup.plugins'));

            const plugins = [
                replace({
                    TEST_FILE_PATH: fullTestPath,
                    TEST_TIMEOUT: options.timeout
                }),
                buble({
                    target: {
                        chrome: 63
                    },
                    jsx: 'React.createElement'
                }),
                assert()
            ].concat(morePlugins || []);

            if (options.coverage) {
                plugins.push(coverage({
                    exclude: [filePath, 'node_modules/**']
                }));
            }

            const bundle = await rollup.rollup({
                input: path.resolve(`${__dirname}/../src`, 'run-node.js'),
                external: ['chalk', 'ramda'],
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
