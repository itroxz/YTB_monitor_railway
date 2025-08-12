// Local parser test harness
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync('./youtube-railway.js', 'utf8');
const sandbox = { module: {}, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const parseViewers = sandbox.parseViewers || sandbox.module.exports?.parseViewers;
if (typeof parseViewers !== 'function') {
  console.error('parseViewers not found in youtube-railway.js');
  process.exit(1);
}

const samples = [
  '18,450 watching now',           // -> 18450
  '18.450 assistindo agora',       // -> 18450
  '18.5k watching now',            // -> 18500
  '18,5 mil assistindo',           // -> 18500
  '1.2M watching',                 // -> 1200000
  '1,2 mi assistindo',             // -> 1200000
  '2.345',                         // -> 2345
  '18 watching now',               // -> 18
  '0 watching',                    // -> 0
  'n/a',                           // -> 0
];

for (const s of samples) {
  console.log(s, '=>', parseViewers(s));
}
