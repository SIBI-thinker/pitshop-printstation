// One job at a time: a low-spec laptop cannot run Office, page counting and printing in parallel.
// Print jobs go first so the person at the counter is never kept waiting behind uploads.
const lanes = { print: [], prepare: [] };
let busy = false;
let current = null;

function add(lane, label, task) {
  lanes[lane].push({ label, task });
  next();
}

async function next() {
  if (busy) return;
  const job = lanes.print.shift() || lanes.prepare.shift();
  if (!job) return;
  busy = true;
  current = job.label;
  try {
    await job.task();
  } catch (err) {
    console.error(`[queue] ${job.label} failed:`, err.message);
  } finally {
    busy = false;
    current = null;
    setImmediate(next);
  }
}

function status() {
  return { current, printing: lanes.print.length, preparing: lanes.prepare.length };
}

module.exports = { add, status };
