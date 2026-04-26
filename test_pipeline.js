"use strict";

const assert = require("assert");
global.window = {};
require("./pipeline_logic.js");

const { analyse } = window.PipelineLogic;

function totals(code, stageCount) {
  const result = analyse(code, { stageCount });
  return {
    noForwarding: result.noForwarding.totalStalls,
    withForwarding: result.withForwarding.totalStalls,
    noForwardingCycles: result.noForwarding.totalCycles,
    withForwardingCycles: result.withForwarding.totalCycles,
  };
}

assert.deepStrictEqual(totals("add $t0, $t1, $t2\nsub $t3, $t0, $t4", 4), {
  noForwarding: 1,
  withForwarding: 0,
  noForwardingCycles: 6,
  withForwardingCycles: 5,
});

assert.deepStrictEqual(totals("add $t0, $t1, $t2\nsub $t3, $t0, $t4", 5), {
  noForwarding: 2,
  withForwarding: 0,
  noForwardingCycles: 8,
  withForwardingCycles: 6,
});

assert.deepStrictEqual(totals("lw $t0, 0($t1)\nadd $t2, $t0, $t3", 5), {
  noForwarding: 2,
  withForwarding: 1,
  noForwardingCycles: 8,
  withForwardingCycles: 7,
});

console.log("pipeline logic tests passed");
