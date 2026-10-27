#!/usr/bin/env node
// Stands in for `claude -p` in tests: echoes args and stdin so the test can assert on them.
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  if (input.includes("FAIL")) {
    console.error("boom");
    process.exit(2);
  }
  console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), input }));
});
