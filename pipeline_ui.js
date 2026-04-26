// ============================================================
//  pipeline_ui.js
//  DOM interaction and simulation controls
// ============================================================

"use strict";

(function () {
  const $ = id => document.getElementById(id);

  const editor = $("editor");
  const runBtn = $("run-btn");
  const clearBtn = $("clear-btn");
  const outputArea = $("output-area");
  const statusBar = $("status-bar");
  const errorBox = $("error-box");
  const stage4Btn = $("stage-4-btn");
  const stage5Btn = $("stage-5-btn");
  const forwardingToggle = $("forwarding-toggle");
  const stepBtn = $("step-btn");
  const autoBtn = $("auto-btn");
  const resetBtn = $("reset-btn");
  const currentCycleEl = $("current-cycle");
  const totalCyclesEl = $("total-cycles");
  const stallCountEl = $("stall-count");

  const STAGE_CLASS = {
    IF: "cell-if",
    ID: "cell-id",
    EX: "cell-ex",
    MEM: "cell-mem",
    WB: "cell-wb",
    ST: "cell-st",
    "": "cell-empty",
  };

  const LOG_SEPARATOR = "__cycle_separator__";

  const state = {
    stageCount: 4,
    forwarding: true,
    currentCycle: 0,
    analysis: null,
    activeResult: null,
    autoTimer: null,
    logLines: [],
  };

  function selectedResult(analysis) {
    return state.forwarding ? analysis.withForwarding : analysis.noForwarding;
  }

  function build() {
    stopAuto();
    const text = editor.value.trim();
    outputArea.innerHTML = "";
    hideError();

    if (!text) {
      showError("No instructions entered.");
      return;
    }

    try {
      state.analysis = window.PipelineLogic.analyse(text, { stageCount: state.stageCount });
      state.activeResult = selectedResult(state.analysis);
      state.currentCycle = 0;
      state.logLines = [
        "Schedule loaded. Press Step or Auto-Run.",
        "Mode: " + state.stageCount + "-stage, forwarding " + (state.forwarding ? "on" : "off") + ".",
      ];
    } catch (e) {
      state.analysis = null;
      state.activeResult = null;
      state.logLines = [];
      showError(e.message);
      syncControls();
      return;
    }

    renderSimulation();
    syncControls();
    setStatus("ready to step");
  }

  function renderSimulation() {
    if (!state.analysis || !state.activeResult) return;

    outputArea.innerHTML = "";
    outputArea.appendChild(renderHazardSummary(state.analysis));
    outputArea.appendChild(renderGrid(state.activeResult));
    outputArea.appendChild(renderLogs());
    updateCycleView();
  }

  function renderGrid(result) {
    const { grid, schedule } = result;
    const { rows, cycles } = grid;
    const section = document.createElement("div");
    section.className = "grid-section";

    const hdr = document.createElement("div");
    hdr.className = "grid-header";
    hdr.innerHTML = `
      <span class="grid-label">${state.stageCount}-stage / ${state.forwarding ? "forwarding on" : "forwarding off"}</span>
      <span class="grid-meta">
        <span class="meta-item">stalls: <em>${result.totalStalls}</em></span>
      </span>`;
    section.appendChild(hdr);

    const table = document.createElement("table");
    table.className = "pipeline-table";

    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");
    headerRow.appendChild(th("Instruction", "col-instr"));
    for (let c = 1; c <= cycles; c++) {
      const cell = th("", "col-cycle");
      cell.dataset.cycle = String(c);
      cell.dataset.cycleLabel = String(c);
      headerRow.appendChild(cell);
    }
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    schedule.forEach((entry, rowIdx) => {
      const tr = document.createElement("tr");
      const instrCell = document.createElement("td");
      instrCell.className = "instr-cell";
      instrCell.textContent = entry.instr.raw;
      tr.appendChild(instrCell);

      rows[rowIdx].forEach((cellVal, cIdx) => {
        const td = document.createElement("td");
        td.className = "stage-cell " + (STAGE_CLASS[cellVal] || "cell-empty");
        td.textContent = "";
        td.dataset.cycle = String(cIdx + 1);
        td.dataset.stageLabel = cellVal || "";
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function renderHazardSummary(analysis) {
    const box = document.createElement("div");
    box.className = "hazard-summary";

    const hazards = findHazards(analysis.instructions);
    const active = selectedResult(analysis);
    const comparison = state.forwarding
      ? "Forwarding is enabled for this run."
      : "Forwarding off shows register-write stalls.";

    let html = '<div class="summary-title">[ HAZARD ANALYSIS ]</div>';
    html += '<div class="summary-stat">Pipeline: <em>' + state.stageCount + '-stage</em> | Forwarding: <em>' + (state.forwarding ? "on" : "off") + "</em></div>";

    if (hazards.length === 0) {
      html += '<div class="summary-row ok">> No RAW data hazards detected.</div>';
    } else {
      hazards.forEach(h => {
        html += '<div class="summary-row hazard">> I' + h.from + " -> I" + h.to + ' <span class="reg-tag">' + h.reg + '</span> <span class="htype ' + (h.type === "Load-Use" ? "ltype" : "rtype") + '">' + h.type + "</span></div>";
      });
    }

    html += '<div class="summary-divider"></div>';
    html += '<div class="summary-stat">Current schedule: <em>' + active.totalStalls + '</em> stall' + (active.totalStalls === 1 ? "" : "s") + "</div>";
    html += '<div class="summary-stat saved">' + comparison + "</div>";
    box.innerHTML = html;
    return box;
  }

  function renderLogs() {
    const section = document.createElement("section");
    section.className = "log-panel";
    section.innerHTML = `
      <div class="log-header">
        <span>Logs</span>
        <span id="log-mode">${state.currentCycle === 0 ? "waiting" : "cycle " + state.currentCycle}</span>
      </div>
      <div id="log-list" class="log-list"></div>`;
    return section;
  }

  function findHazards(instructions) {
    const hazards = [];
    for (let i = 0; i < instructions.length; i++) {
      for (let j = 0; j < i; j++) {
        const prod = instructions[j];
        const cons = instructions[i];
        if (prod.dest && cons.srcs.includes(prod.dest)) {
          hazards.push({
            from: j + 1,
            to: i + 1,
            reg: prod.dest,
            type: prod.type === "LW" ? "Load-Use" : "RAW",
          });
        }
      }
    }
    return hazards;
  }

  function step() {
    if (!state.activeResult) return;
    if (state.currentCycle < state.activeResult.totalCycles) {
      state.currentCycle += 1;
      appendCycleLogs();
      updateCycleView();
      setStatus("cycle " + state.currentCycle);
    }
    if (state.currentCycle >= state.activeResult.totalCycles) {
      stopAuto();
      setStatus("simulation complete | total cycles " + state.activeResult.totalCycles);
    }
    syncControls();
  }

  function resetSimulation() {
    stopAuto();
    state.currentCycle = 0;
    state.logLines = [
      "Schedule reset. Press Step or Auto-Run.",
      "Mode: " + state.stageCount + "-stage, forwarding " + (state.forwarding ? "on" : "off") + ".",
    ];
    updateCycleView();
    syncControls();
    setStatus(state.activeResult ? "reset to cycle 0" : "ready");
  }

  function toggleAuto() {
    if (!state.activeResult) return;
    if (state.autoTimer) {
      stopAuto();
      syncControls();
      return;
    }
    if (state.currentCycle >= state.activeResult.totalCycles) {
      state.currentCycle = 0;
    }
    state.autoTimer = window.setInterval(step, 600);
    autoBtn.textContent = "Pause";
    setStatus("auto-run active");
    step();
  }

  function stopAuto() {
    if (state.autoTimer) {
      window.clearInterval(state.autoTimer);
      state.autoTimer = null;
    }
    autoBtn.textContent = ">> Auto-Run";
  }

  function updateCycleView() {
    const total = state.activeResult ? state.activeResult.totalCycles : 0;
    const complete = total > 0 && state.currentCycle >= total;
    currentCycleEl.textContent = String(state.currentCycle);
    totalCyclesEl.textContent = complete ? String(total) : "-";
    stallCountEl.textContent = state.activeResult ? String(state.activeResult.totalStalls) : "0";

    document.querySelectorAll("[data-cycle]").forEach(el => {
      const cycle = Number(el.dataset.cycle);
      const reached = state.currentCycle > 0 && cycle <= state.currentCycle;
      el.classList.toggle("active-cycle", cycle === state.currentCycle);
      el.classList.toggle("past-cycle", reached && cycle < state.currentCycle);
      el.classList.toggle("future-cycle", !reached);

      if (el.classList.contains("stage-cell")) {
        el.textContent = reached ? el.dataset.stageLabel : "";
      } else if (el.classList.contains("col-cycle")) {
        el.textContent = reached ? el.dataset.cycleLabel : "";
      }
    });

    renderLogList();
  }

  function renderLogList() {
    const list = $("log-list");
    const mode = $("log-mode");
    if (!list || !mode) return;

    const total = state.activeResult ? state.activeResult.totalCycles : 0;
    const complete = total > 0 && state.currentCycle >= total;
    mode.textContent = state.currentCycle === 0 ? "waiting" : complete ? "complete" : "cycle " + state.currentCycle;
    list.innerHTML = "";

    const lines = state.logLines.length ? state.logLines : ["Build a program to start the simulation."];
    lines.forEach(line => {
      if (line === LOG_SEPARATOR) {
        const separator = document.createElement("div");
        separator.className = "log-separator";
        list.appendChild(separator);
        return;
      }

      const item = document.createElement("div");
      item.className = "log-item";
      item.textContent = line;
      list.appendChild(item);
    });
    list.scrollTop = list.scrollHeight;
  }

  function appendCycleLogs() {
    if (!state.activeResult || state.currentCycle === 0) return;
    const lines = [];
    state.activeResult.schedule.forEach((entry, idx) => {
      const cell = state.activeResult.grid.rows[idx][state.currentCycle - 1];
      if (cell) {
        lines.push("C" + state.currentCycle + ": I" + (idx + 1) + " " + entry.instr.raw + " -> " + cell);
      }
    });

    if (!lines.length) lines.push("C" + state.currentCycle + ": pipeline idle.");
    if (state.logLines.length) state.logLines.push(LOG_SEPARATOR);
    state.logLines.push(...lines);
  }

  function syncControls() {
    const hasRun = Boolean(state.activeResult);
    const finished = hasRun && state.currentCycle >= state.activeResult.totalCycles;
    stepBtn.disabled = !hasRun || finished;
    autoBtn.disabled = !hasRun;
    resetBtn.disabled = !hasRun;
    stage4Btn.classList.toggle("active", state.stageCount === 4);
    stage5Btn.classList.toggle("active", state.stageCount === 5);
    forwardingToggle.checked = state.forwarding;
    if (!state.autoTimer) autoBtn.textContent = ">> Auto-Run";
  }

  function th(text, cls) {
    const el = document.createElement("th");
    el.className = cls || "";
    el.textContent = text;
    return el;
  }

  function showError(msg) {
    errorBox.textContent = "ERROR: " + msg;
    errorBox.style.display = "block";
    setStatus("parse error - check input");
  }

  function hideError() {
    errorBox.textContent = "";
    errorBox.style.display = "none";
  }

  function setStatus(msg) {
    statusBar.textContent = "> " + msg;
  }

  function clearAll() {
    stopAuto();
    editor.value = "";
    outputArea.innerHTML = "";
    hideError();
    state.analysis = null;
    state.activeResult = null;
    state.currentCycle = 0;
    state.logLines = [];
    currentCycleEl.textContent = "0";
    totalCyclesEl.textContent = "-";
    stallCountEl.textContent = "0";
    syncControls();
    setStatus("ready");
    editor.focus();
  }

  function setStageCount(count) {
    if (state.stageCount === count) return;
    state.stageCount = count;
    syncControls();
    if (state.analysis) build();
  }

  function setForwarding(enabled) {
    state.forwarding = enabled;
    if (state.analysis) {
      state.activeResult = selectedResult(state.analysis);
      state.currentCycle = 0;
      state.logLines = [
        "Schedule reloaded. Press Step or Auto-Run.",
        "Mode: " + state.stageCount + "-stage, forwarding " + (enabled ? "on" : "off") + ".",
      ];
      stopAuto();
      renderSimulation();
      syncControls();
      setStatus("forwarding " + (enabled ? "enabled" : "disabled"));
    }
  }

  function init() {
    syncControls();
    setStatus("ready - enter instructions");

    runBtn.addEventListener("click", build);
    clearBtn.addEventListener("click", clearAll);
    stepBtn.addEventListener("click", step);
    autoBtn.addEventListener("click", toggleAuto);
    resetBtn.addEventListener("click", resetSimulation);
    stage4Btn.addEventListener("click", () => setStageCount(4));
    stage5Btn.addEventListener("click", () => setStageCount(5));
    forwardingToggle.addEventListener("change", e => setForwarding(e.target.checked));

    editor.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        build();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
