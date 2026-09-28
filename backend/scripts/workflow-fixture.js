const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const workflowPath = path.join(root, "workflow.json");

function loadWorkflow() {
  return JSON.parse(fs.readFileSync(workflowPath, "utf8"));
}

module.exports = { root, workflowPath, loadWorkflow };
