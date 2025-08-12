// Local parser test harness requiring standalone module
const { parseViewers } = require('./parse-viewers');

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
