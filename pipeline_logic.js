// ============================================================
//  pipeline_logic.js
//  Pure logic module — zero DOM dependencies
//  Supports: 4-stage (IF ID EX MEM) and 5-stage (IF ID EX MEM WB)
//
//  FORWARDING RULES:
//    With forwarding:
//      R/I-type RAW → EX→EX path:  consumer EX > producer EX  (0 stalls at dist=1)
//      Load-Use RAW → MEM→EX path: consumer EX > producer MEM (1 stall, unavoidable)
//
//    Without forwarding:
//      4-stage: register written after MEM.
//        consumer ID must start > producer MEM → minEx = producer.cycleMem + 2
//      5-stage: register written after WB.
//        consumer ID must start > producer WB  → minEx = producer.cycleWb  + 2
//
//  STALL / FETCH INTERACTION:
//    In a real in-order pipeline, stalling ID/EX also stalls IF (PC is held).
//    So instruction i+1 cannot be fetched until instruction i moves to ID.
//    cycleIf[i+1] = max(i+2, cycleId[i])
// ============================================================

"use strict";

// ── Instruction types ────────────────────────────────────────
const INSTR_TYPE = {
  R:  "R",   // add, sub, and, or, slt, nor, xor, sll, srl, mul, div
  I:  "I",   // addi, addiu, andi, ori, slti
  LW: "LW",  // lw
  SW: "SW",  // sw
};

// Map opcode → type
const OPCODE_MAP = {
  add:   INSTR_TYPE.R,
  sub:   INSTR_TYPE.R,
  and:   INSTR_TYPE.R,
  or:    INSTR_TYPE.R,
  slt:   INSTR_TYPE.R,
  nor:   INSTR_TYPE.R,
  xor:   INSTR_TYPE.R,
  sll:   INSTR_TYPE.R,
  srl:   INSTR_TYPE.R,
  mul:   INSTR_TYPE.R,
  div:   INSTR_TYPE.R,
  addi:  INSTR_TYPE.I,
  addiu: INSTR_TYPE.I,
  andi:  INSTR_TYPE.I,
  ori:   INSTR_TYPE.I,
  slti:  INSTR_TYPE.I,
  lw:    INSTR_TYPE.LW,
  sw:    INSTR_TYPE.SW,
};

// ── Register normalisation ───────────────────────────────────
// $T0 → $t0,  t0 → $t0,  7 → null (immediate)
function normaliseReg(r) {
  if (!r) return null;
  if (/^\d+$/.test(r)) return null;
  let s = r.trim().toLowerCase();
  if (!s.startsWith("$")) s = "$" + s;
  return s;
}

// ── Parse one instruction line ───────────────────────────────
// Accepted formats:
//   add $t0, $t1, $t2
//   lw  $t0, 0($t1)
//   sw  $t0, 0($t1)
//   ori $t5, $t6, 7
function parseInstruction(raw) {
  const line = raw.trim().replace(/\s+/g, " ");
  if (!line) return null;

  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) throw new Error(`Cannot parse instruction: "${raw}"`);

  const opcode = line.slice(0, spaceIdx).toLowerCase();
  const rest   = line.slice(spaceIdx + 1);

  const type = OPCODE_MAP[opcode];
  if (!type) {
    throw new Error(
      `Unknown opcode: "${opcode}". Supported: add sub and or slt nor xor sll srl mul div addi addiu andi ori slti lw sw`
    );
  }

  // Expand offset($reg) → offset, $reg, then split on commas
  const tokens = rest
    .replace(/\(([^)]+)\)/g, ", $1")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  let dest = null;
  let srcs = [];

  if (type === INSTR_TYPE.R) {
    // add $rd, $rs, $rt  →  dest=$rd, srcs=[$rs,$rt]
    if (tokens.length < 3)
      throw new Error(`R-type needs 3 operands: "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[1]), normaliseReg(tokens[2])];

  } else if (type === INSTR_TYPE.I) {
    // ori $rt, $rs, imm  →  dest=$rt, srcs=[$rs]
    if (tokens.length < 3)
      throw new Error(`I-type needs 3 operands: "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[1])];   // immediate is not a register

  } else if (type === INSTR_TYPE.LW) {
    // lw $rt, offset($rs)  →  dest=$rt, srcs=[$rs]
    if (tokens.length < 3)
      throw new Error(`lw format: lw $dest, offset($base) — got: "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[2])];   // tokens[1] is the numeric offset

  } else if (type === INSTR_TYPE.SW) {
    // sw $rt, offset($rs)  →  dest=null, srcs=[$rt,$rs]
    if (tokens.length < 3)
      throw new Error(`sw format: sw $src, offset($base) — got: "${raw}"`);
    dest = null;
    srcs = [normaliseReg(tokens[0]), normaliseReg(tokens[2])];
  }

  return { opcode, type, dest, srcs, raw: line };
}

// ── Parse multiple instruction lines ─────────────────────────
function parseInstructions(text) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("#"));

  if (lines.length === 0) throw new Error("No instructions entered.");
  if (lines.length > 20)  throw new Error("Max 20 instructions supported.");

  return lines.map((line, i) => {
    try {
      const instr = parseInstruction(line);
      if (!instr) throw new Error("Empty line.");
      instr.index = i;
      return instr;
    } catch (e) {
      throw new Error(`Line ${i + 1}: ${e.message}`);
    }
  });
}

// ── Stage list per pipeline mode ─────────────────────────────
const PIPELINE_STAGES = {
  4: ["IF", "ID", "EX", "MEM"],
  5: ["IF", "ID", "EX", "MEM", "WB"],
};

function getStages(stageCount = 4) {
  return PIPELINE_STAGES[stageCount] || PIPELINE_STAGES[4];
}

// ── Core pipeline scheduler ──────────────────────────────────
//
// For each instruction we compute the cycle number for every stage,
// then work out how many stall bubbles are needed before ID.
//
// Key invariant maintained here:
//   In a stalling in-order pipeline, a stall in stage ID also stalls IF.
//   Therefore: cycleIf[i+1] = max(i+2,  cycleId[i])
//   i.e., the next instruction cannot be fetched until the current one
//   advances to ID (freeing the IF/ID pipeline register).
//
function buildPipeline(instructions, forwarding, stageCount = 4) {
  const schedule = [];

  for (let i = 0; i < instructions.length; i++) {
    const instr = instructions[i];
    const prev  = schedule[i - 1] || null;

    // ── Compute cycleIf ────────────────────────────────────
    // Without any stalls, instruction i fetches at cycle i+1.
    // But if the previous instruction was stalled (its ID was pushed
    // out), it held the IF stage busy → we must wait until prev leaves IF.
    // In hardware: the PC register is stalled while the pipeline is stalled,
    // so cycleIf[i] ≥ cycleId[i-1]  (next fetch after prev moves to ID).
    let cycleIf = i + 1;
    if (prev) {
      cycleIf = Math.max(cycleIf, prev.cycleId);
    }

    // ── Starting point (no stalls yet) ─────────────────────
    let cycleId  = cycleIf + 1;
    let cycleEx  = cycleId + 1;
    let cycleMem = cycleEx + 1;
    let cycleWb  = stageCount === 5 ? cycleMem + 1 : null;

    // ── RAW hazard checks ───────────────────────────────────
    for (let j = 0; j < i; j++) {
      const producer = schedule[j].instr;
      const consumer  = instr;

      if (!producer.dest) continue;
      if (!consumer.srcs.includes(producer.dest)) continue;

      // This is a RAW hazard. Compute the minimum cycle for consumer's EX.
      let minEx;

      if (forwarding) {
        if (producer.type === INSTR_TYPE.LW) {
          // MEM→EX forwarding path:
          //   Result available at end of producer MEM.
          //   Consumer EX must start strictly after producer MEM ends.
          //   minEx = producer.cycleMem + 1
          //   → 1 stall when instructions are adjacent (dist=1)
          //   → 0 stalls when there is already a gap (dist≥2)
          minEx = schedule[j].cycleMem + 1;
        } else {
          // EX→EX forwarding path:
          //   Result available at end of producer EX.
          //   Consumer EX must start strictly after producer EX ends.
          //   minEx = producer.cycleEx + 1
          //   → 0 stalls when instructions are adjacent (the forwarded
          //     value arrives just in time for consumer EX)
          minEx = schedule[j].cycleEx + 1;
        }
      } else {
        // No forwarding: consumer reads register file at ID.
        // Register is written at: MEM (4-stage) or WB (5-stage).
        // consumer ID must start strictly AFTER the write stage.
        //   minId = writeStage + 1
        //   minEx = minId + 1
        if (stageCount === 5) {
          minEx = schedule[j].cycleWb + 2;   // minId = WB+1, minEx = WB+2
        } else {
          minEx = schedule[j].cycleMem + 2;  // minId = MEM+1, minEx = MEM+2
        }
      }

      // Apply the constraint if it pushes EX later
      if (minEx > cycleEx) {
        cycleEx  = minEx;
        cycleId  = cycleEx - 1;
        cycleMem = cycleEx + 1;
        cycleWb  = stageCount === 5 ? cycleMem + 1 : null;
      }
    }

    // ── Stall count ─────────────────────────────────────────
    // Number of bubble cycles inserted between IF and ID.
    const stalls = Math.max(0, cycleId - (cycleIf + 1));

    // ── Stage-cycle pairs ───────────────────────────────────
    const stageCycles = [
      { cycle: cycleIf,  stage: "IF"  },
      { cycle: cycleId,  stage: "ID"  },
      { cycle: cycleEx,  stage: "EX"  },
      { cycle: cycleMem, stage: "MEM" },
    ];
    if (stageCount === 5) {
      stageCycles.push({ cycle: cycleWb, stage: "WB" });
    }

    schedule.push({
      instr,
      cycleIf,
      cycleId,
      cycleEx,
      cycleMem,
      cycleWb,
      stalls,
      naturalStart: i + 1,
      stageCycles,
    });
  }

  return schedule;
}

// ── Total cycle count for a schedule ─────────────────────────
function totalCycles(schedule, stageCount = 4) {
  if (!schedule.length) return 0;
  const last = schedule[schedule.length - 1];
  return stageCount === 5 ? last.cycleWb : last.cycleMem;
}

// ── Build 2-D grid (rows = instructions, cols = cycles) ──────
// Cell values: "IF" | "ID" | "EX" | "MEM" | "WB" | "ST" | ""
function buildGrid(schedule, stageCount = 4) {
  const cycles = totalCycles(schedule, stageCount);
  const rows = schedule.map((entry) => {
    const row = new Array(cycles).fill("");

    // Stall slots: cycles between IF and ID (exclusive)
    for (let c = entry.cycleIf + 1; c < entry.cycleId; c++) {
      row[c - 1] = "ST";
    }

    // Pipeline stage slots
    entry.stageCycles.forEach(({ cycle, stage }) => {
      row[cycle - 1] = stage;
    });

    return row;
  });

  return { rows, cycles };
}

// ── Hazard detector (for summary display) ────────────────────
function detectHazards(instructions) {
  const hazards = [];
  for (let i = 0; i < instructions.length; i++) {
    for (let j = 0; j < i; j++) {
      const prod = instructions[j];
      const cons = instructions[i];
      if (!prod.dest) continue;
      if (!cons.srcs.includes(prod.dest)) continue;
      hazards.push({
        producerIdx: j,
        consumerIdx: i,
        reg:         prod.dest,
        isLoadUse:   prod.type === INSTR_TYPE.LW,
        distance:    i - j,
      });
    }
  }
  return hazards;
}

// ── Top-level API ─────────────────────────────────────────────
// Called by pipeline_ui.js with: analyse(text, { stageCount: 4|5 })
// Returns everything the UI needs for both forwarding modes.
function analyse(instrText, options = {}) {
  const stageCount  = Number(options.stageCount) === 5 ? 5 : 4;
  const instructions = parseInstructions(instrText);
  const hazards      = detectHazards(instructions);

  const schedNoFwd  = buildPipeline(instructions, false, stageCount);
  const schedFwd    = buildPipeline(instructions, true,  stageCount);

  return {
    instructions,
    hazards,
    stageCount,
    stages: getStages(stageCount),

    noForwarding: {
      schedule:    schedNoFwd,
      grid:        buildGrid(schedNoFwd, stageCount),
      totalCycles: totalCycles(schedNoFwd, stageCount),
      totalStalls: schedNoFwd.reduce((a, e) => a + e.stalls, 0),
    },

    withForwarding: {
      schedule:    schedFwd,
      grid:        buildGrid(schedFwd, stageCount),
      totalCycles: totalCycles(schedFwd, stageCount),
      totalStalls: schedFwd.reduce((a, e) => a + e.stalls, 0),
    },
  };
}

// ── Exports ───────────────────────────────────────────────────
window.PipelineLogic = {
  analyse,
  parseInstructions,
  detectHazards,
  buildPipeline,
  buildGrid,
  totalCycles,
  getStages,
  PIPELINE_STAGES,
  INSTR_TYPE,
};