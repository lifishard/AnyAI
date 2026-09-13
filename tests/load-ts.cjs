const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
/** Load the real TypeScript modules with narrow boundary fakes, without a bundler. */
function loader(overrides = {}) {
  const cache = new Map();
  return function load(file) {
    file = path.resolve(file);
    if (overrides[file]) return overrides[file];
    if (cache.has(file)) return cache.get(file).exports;
    const mod = { exports: {} }; cache.set(file, mod);
    const req = createRequire(file);
    const local = (name) => {
      if (overrides[name]) return overrides[name];
      if (name.startsWith('.')) {
        const p = path.resolve(path.dirname(file), name);
        for (const candidate of [p, p+'.ts', p+'.cjs']) {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate.endsWith('.ts') || candidate.endsWith('.cjs') ? load(candidate) : req(candidate);
        }
      }
      return req(name);
    };
    const source = fs.readFileSync(file, 'utf8');
    const code = file.endsWith('.ts') ? ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText : source;
    vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){${code}\n})`, { filename: file })(local, mod, mod.exports, file, path.dirname(file));
    return mod.exports;
  };
}
module.exports = { loader };
