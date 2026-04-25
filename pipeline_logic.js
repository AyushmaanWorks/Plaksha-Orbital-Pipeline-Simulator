// ============================================================
//  pipeline_logic.js
//  Pure logic module — zero DOM dependencies
//  4-stage MIPS pipeline: IF | ID | EX | MEM
// ============================================================

"use strict";

// ── Instruction types ────────────────────────────────────────
const INSTR_TYPE = {
  R:  "R",   // add, sub, and, or, slt, ...
  I:  "I",   // addi, ori, andi, ...
  LW: "LW",  // lw
  SW: "SW",  // sw
};

// Map opcode → type
const OPCODE_MAP = {
  add:  INSTR_TYPE.R,
  sub:  INSTR_TYPE.R,
  and:  INSTR_TYPE.R,
  or:   INSTR_TYPE.R,
  slt:  INSTR_TYPE.R,
  nor:  INSTR_TYPE.R,
  xor:  INSTR_TYPE.R,
  sll:  INSTR_TYPE.R,
  srl:  INSTR_TYPE.R,
  mul:  INSTR_TYPE.R,
  div:  INSTR_TYPE.R,
  addi: INSTR_TYPE.I,
  addiu:INSTR_TYPE.I,
  andi: INSTR_TYPE.I,
  ori:  INSTR_TYPE.I,
  slti: INSTR_TYPE.I,
  lw:   INSTR_TYPE.LW,
  sw:   INSTR_TYPE.SW,
};

// ── Parse a single instruction string ───────────────────────
// Accepts formats:
//   add $t0, $t1, $t2
//   lw  $t0, 0($t1)
//   sw  $t0, 0($t1)
//   ori $t5, $t6, 7
function parseInstruction(raw) {
  const line = raw.trim().replace(/\s+/g, " ");
  if (!line) return null;

  // Split on first space to get opcode
  const spaceIdx = line.indexOf(" ");
  if (spaceIdx === -1) throw new Error(`Cannot parse instruction: "${raw}"`);

  const opcode = line.slice(0, spaceIdx).toLowerCase();
  const rest   = line.slice(spaceIdx + 1);

  const type = OPCODE_MAP[opcode];
  if (!type) throw new Error(`Unknown opcode: "${opcode}"`);

  // Tokenise operands (strip whitespace, parens)
  const tokens = rest
    .replace(/\(([^)]+)\)/g, ", $1") // 0($t1) → 0, $t1
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  let dest = null;   // register written
  let srcs = [];     // registers read

  if (type === INSTR_TYPE.R) {
    // add $rd, $rs, $rt  → dest=$rd, srcs=[$rs,$rt]
    if (tokens.length < 3) throw new Error(`R-type needs 3 operands: "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[1]), normaliseReg(tokens[2])];

  } else if (type === INSTR_TYPE.I) {
    // ori $rt, $rs, imm  → dest=$rt, srcs=[$rs]
    if (tokens.length < 3) throw new Error(`I-type needs 3 operands: "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[1])];   // immediate is not a register

  } else if (type === INSTR_TYPE.LW) {
    // lw $rt, offset($rs) → dest=$rt, srcs=[$rs]
    if (tokens.length < 3) throw new Error(`lw needs 3 operands (after expansion): "${raw}"`);
    dest = normaliseReg(tokens[0]);
    srcs = [normaliseReg(tokens[2])];   // tokens[1] is offset (number)

  } else if (type === INSTR_TYPE.SW) {
    // sw $rt, offset($rs) → dest=null, srcs=[$rt,$rs]
    if (tokens.length < 3) throw new Error(`sw needs 3 operands (after expansion): "${raw}"`);
    dest = null;
    srcs = [normaliseReg(tokens[0]), normaliseReg(tokens[2])];
  }

  return { opcode, type, dest, srcs, raw: line };
}

// Normalise register names: $T0→$t0, t0→$t0, etc.
function normaliseReg(r) {
  if (!r) return null;
  if (/^\d+$/.test(r)) return null; // it's an immediate / offset
  let s = r.trim().toLowerCase();
  if (!s.startsWith("$")) s = "$" + s;
  return s;
}

// ── Parse a block of instruction lines ──────────────────────
function parseInstructions(text) {
  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l && !l.startsWith("//") && !l.startsWith("#"));

  return lines.map((line, i) => {
    try {
      const instr = parseInstruction(line);
      if (!instr) throw new Error("Empty line");
      instr.index = i;
      return instr;
    } catch (e) {
      throw new Error(`Line ${i + 1}: ${e.message}`);
    }
  });
}

// ── Pipeline stage constants ─────────────────────────────────
const PIPELINE_STAGES = {
  4: ["IF", "ID", "EX", "MEM"],
  5: ["IF", "ID", "EX", "MEM", "WB"],
};

const STAGES = PIPELINE_STAGES[4];

function getStages(stageCount = 4) {
  return PIPELINE_STAGES[stageCount] || PIPELINE_STAGES[4];
}

// ── Build pipeline schedule ──────────────────────────────────
// Returns: Array of { instr, stages: [{cycle, stage}], stalls }
function buildPipeline(instructions, forwarding, stageCount = 4) {
  const n = instructions.length;
  const stages = getStages(stageCount);
  // schedule[i] = cycle at which instruction i starts IF
  const startCycle = new Array(n).fill(0);
  // stallsBefore[i] = stalls injected before instruction i starts ID
  const stallsBefore = new Array(n).fill(0);

  for (let i = 0; i < n; i++) {
    // Earliest this instruction can start (= prev finishes IF)
    const prevStart = i === 0 ? 1 : startCycle[i - 1] + 1;
    startCycle[i] = prevStart;

    // Check RAW hazards against all earlier instructions
    let extraStalls = 0;

    for (let j = 0; j < i; j++) {
      const producer = instructions[j];
      const consumer = instructions[i];

      if (!producer.dest) continue;

      const isRAW = consumer.srcs.includes(producer.dest);
      if (!isRAW) continue;

      // Distance in issue cycles (ignoring stalls already added)
      const prodStart = startCycle[j];
      const consStart = startCycle[i]; // tentative, increases with extraStalls

      if (forwarding) {
        if (producer.type === INSTR_TYPE.LW) {
          // Load-use hazard: MEM→EX forwarding path.
          // Producer MEM ends at cycle: prodStart + 3
          // Consumer EX  starts at:    consStart + 2
          // Need: consStart + 2 >= prodStart + 3  →  consStart >= prodStart + 1
          // Since consStart starts at prodStart+1 (sequential issue), gap = 0 initially.
          // But we also need the *result* to be ready at the *start* of consumer EX,
          // which requires consStart + 2 > prodStart + 2  i.e. consStart > prodStart.
          // The strict requirement for load-use with MEM→EX forwarding is:
          //   consumer EX must start strictly after producer MEM ends
          //   i.e., consStart + 2 > prodStart + 3  →  consStart > prodStart + 1
          // So minimum consStart = prodStart + 2, meaning 1 stall if consStart = prodStart+1.
          const minConsStart = prodStart + 2;
          const gap = minConsStart - consStart;
          if (gap > extraStalls) extraStalls = gap;
        }
        // For R/I types: EX→EX forwarding — no stalls needed as long as issue order holds.
      } else {
        // Without forwarding: consumer needs register value at ID stage.
        // Register written after WB — but in 4-stage pipeline WB is merged with MEM.
        // Effectively register is available after MEM: cycle prodStart + 3.
        // Consumer reads at ID: cycle consStart + 1.
        // Need: consStart + 1 > prodStart + 3  →  consStart >= prodStart + 3.
        const writeStageOffset = stageCount === 5 ? 4 : 3;
        const minConsStart = prodStart + writeStageOffset;
        const gap = minConsStart - consStart;
        if (gap > extraStalls) extraStalls = gap;
      }
    }

    startCycle[i] += extraStalls;
    stallsBefore[i] = extraStalls;
  }

  // Build stage-cycle pairs for each instruction
  const result = instructions.map((instr, i) => {
    const s = startCycle[i];
    // Natural start = if no stalls had ever occurred (back-to-back issue)
    const naturalStart = i + 1;
    // Total stall slots = how many cycles late vs back-to-back issue
    const totalStallSlots = s - naturalStart;
    return {
      instr,
      stalls: totalStallSlots,
      stageCycles: stages.map((stage, si) => ({ cycle: s + si, stage })),
      startCycle: s,
      naturalStart,
    };
  });

  return result;
}

// ── Total cycles in the pipeline run ────────────────────────
function totalCycles(schedule, stageCount = 4) {
  if (!schedule.length) return 0;
  const last = schedule[schedule.length - 1];
  return last.startCycle + getStages(stageCount).length - 1;
}

// ── Build a 2D grid: rows=instructions, cols=cycles ──────────
// cell value: "IF"|"ID"|"EX"|"MEM"|"ST"(stall)|""
function buildGrid(schedule, stageCount = 4) {
  const cycles = totalCycles(schedule, stageCount);
  const rows = schedule.map((entry, rowIdx) => {
    const row = new Array(cycles).fill("");
    // Mark stall slots: from naturalStart to startCycle-1 (all cycles the instr is waiting)
    for (let c = entry.naturalStart; c < entry.startCycle; c++) {
      row[c - 1] = "ST";
    }
    // Mark pipeline stages
    entry.stageCycles.forEach(({ cycle, stage }) => {
      row[cycle - 1] = stage;
    });
    return row;
  });
  return { rows, cycles };
}

// ── High-level API ───────────────────────────────────────────
function analyse(instrText, options = {}) {
  const stageCount = Number(options.stageCount) === 5 ? 5 : 4;
  const instructions = parseInstructions(instrText);

  const scheduleNoFwd  = buildPipeline(instructions, false, stageCount);
  const scheduleWithFwd = buildPipeline(instructions, true, stageCount);

  return {
    instructions,
    stageCount,
    stages: getStages(stageCount),
    noForwarding: {
      schedule: scheduleNoFwd,
      grid: buildGrid(scheduleNoFwd, stageCount),
      totalCycles: totalCycles(scheduleNoFwd, stageCount),
      totalStalls: scheduleNoFwd.reduce((a, e) => a + e.stalls, 0),
    },
    withForwarding: {
      schedule: scheduleWithFwd,
      grid: buildGrid(scheduleWithFwd, stageCount),
      totalCycles: totalCycles(scheduleWithFwd, stageCount),
      totalStalls: scheduleWithFwd.reduce((a, e) => a + e.stalls, 0),
    },
  };
}

// ── Exports ──────────────────────────────────────────────────
window.PipelineLogic = { analyse, parseInstructions, STAGES, PIPELINE_STAGES, getStages, INSTR_TYPE };
