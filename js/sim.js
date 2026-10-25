"use strict";
  const elCar = $("elevator-car"), elLoad = $("elevator-load"), pileVal = $("pile-val");
  const bnEl = $("bottleneck"), whLane = $("wh-lane"), whBuilding = $("wh-building");
  let cashLog = [], rateMin = 0, slowT = 0, bottleneck = null;
  const t0 = performance.now() / 1000;
  let elevatorSim, minerSim = [], workerSim = [];
  const floorUI = [];
  function resetSims() {
    workerSim.forEach((w) => w.el && w.el.remove());
    workerSim = [];
    minerSim = [];
    elevatorSim = { pos: 0, state: "idle", t: 0.6, target: 0, u: 0, v: 0, plan: 0, planV: 0, dur: 0.4 };
  }
  resetSims();

  function tick(dt) {
    const mine = activeMine();
    const rm = researchMult();
    updateMiners(dt, mine, rm);
    updateElevator(dt, mine, rm);
    updateWorkers(dt, mine, rm);
    heroTick(dt, mine);
    slowT += dt;
    if (slowT > 0.25) {
      slowT = 0;
      rateMin = cashPerMin();
      refreshFloors(mine, rm);
      detectBottleneck(mine, rm);
      updateHeroVisuals(mine, rm);
    }
    renderGameVisuals(mine, rm);
    renderHUD();
  }

  function cashPerMin() {
    const now = performance.now() / 1000;
    cashLog = cashLog.filter((c) => now - c.t < 30);
    const span = Math.max(8, Math.min(30, now - t0));
    return (cashLog.reduce((s, c) => s + c.v, 0) / span) * 60;
  }

  function deliver(v) {
    v *= 1 + fx.fort;
    state.cash += v;
    state.stats.totalEarned += v;
    cashLog.push({ t: performance.now() / 1000, v });
    const el = document.createElement("div");
    el.className = "cash-particle";
    el.textContent = "+" + formatMoney(v);
    el.style.left = "10%";
    el.style.top = "-8px";
    whBuilding.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }

  // ---- actors (miners + warehouse workers) ----
  function makeActor(kind, idx) {
    const el = document.createElement("div");
    el.className = "actor " + (kind === "w" ? "worker" : "miner");
    el.style.bottom = (idx % 2) * 5 + "px";
    el.innerHTML = '<span class="a-body">👷</span>' + (kind === "w" ? "" : '<span class="a-pick">⛏️</span>') + '<i class="a-load"></i>';
    return el;
  }

  function paint(m) {
    const c = m.el.classList, w = m.kind === "w";
    c.toggle("swinging", !w && m.s === "swing");
    c.toggle("carrying", w ? m.s === "out" : m.s === "back");
    c.toggle("flip", m.s === "back");
    c.toggle("walking", m.s === "out" || m.s === "back");
  }

  function syncMiners(i, mine) {
    const lane = floorUI[i] && floorUI[i].lane;
    if (!lane) return;
    const want = minersFor(mine.shafts[i].level);
    const sims = (minerSim[i] = minerSim[i] || []);
    while (sims.length < want) sims.push({ kind: "m", s: "wait", t: sims.length * 0.9, p: 0, load: 0 });
    sims.splice(want).forEach((m) => m.el && m.el.remove());
    sims.forEach((m, k) => {
      if (!m.el || m.el.parentNode !== lane) {
        m.el = makeActor("m", k);
        lane.appendChild(m.el);
        paint(m);
      }
    });
  }

  function syncWorkers(n) {
    while (workerSim.length < n) workerSim.push({ kind: "w", s: "wait", t: workerSim.length * 0.8, p: 0, v: 0 });
    workerSim.splice(n).forEach((w) => w.el && w.el.remove());
    workerSim.forEach((w, k) => {
      if (!w.el) {
        w.el = makeActor("w", k);
        whLane.appendChild(w.el);
        paint(w);
      }
    });
  }

  // Miner loop: walk to the end of the tunnel -> swing pickaxe -> walk back -> drop ore in the floor box
  function updateMiners(dt, mine, rm) {
    for (let i = 0; i < mine.unlockedShaftCount; i++) {
      const sims = minerSim[i];
      if (!sims || !sims.length) continue;
      const sh = mine.shafts[i];
      const speed = hmult.s;
      const trip = (floorUnitRate(i, mine, rm) * T_MINER) / sims.length;
      for (const m of sims) {
        const was = m.s;
        if (m.s === "wait") {
          m.t -= dt;
          if (m.t <= 0) m.s = "out";
        } else if (m.s === "out") {
          m.p += (dt * speed) / WALK;
          if (m.p >= 1) { m.p = 1; m.s = "swing"; m.t = (SWING_N * SWING_T) / speed; }
        } else if (m.s === "swing") {
          m.t -= dt;
          if (m.t <= 0) { m.s = "back"; m.load = trip * (Math.random() < fx.lucky ? 3 : 1); }
        } else if (m.s === "back") {
          m.p -= (dt * speed) / WALK;
          if (m.p <= 0) {
            m.p = 0; m.s = "drop"; m.t = DROP / speed;
            sh.stock += m.load;
            m.load = 0;
            bump(floorUI[i] && floorUI[i].boxEl);
            rollDrop(i);
          }
        } else {
          m.t -= dt;
          if (m.t <= 0) m.s = "out";
        }
        if (m.s !== was) paint(m);
        m.el.style.left = m.p * 100 + "%";
      }
    }
  }

  // Elevator stops: 0 = surface, k = floor k. It only ever visits unlocked floors.
  function stopY(p) {
    const y0 = L.surface - L.grass - L.car;
    const y1 = L.surface + L.head + L.tunnel - L.car;
    return p <= 1 ? y0 + (y1 - y0) * p : y1 + (p - 1) * L.floor;
  }

  function elevatorNext(e, n, cap) {
    if (e.u >= cap * 0.999 || e.target >= n) e.target = 0;
    else e.target += 1;
    e.state = "move";
  }

  function updateElevator(dt, mine, rm) {
    const e = elevatorSim, n = mine.unlockedShaftCount;
    const cap = elevatorCapacity(mine.elevator.level, rm.elevatorCapMult);
    if (e.state === "idle") {
      e.t -= dt;
      if (e.t <= 0) {
        if (mine.shafts.slice(0, n).some((s) => s.stock > 0.5)) { e.state = "move"; e.target = 1; }
        else e.t = 0.25;
      }
    } else if (e.state === "move") {
      const step = elevatorTravel(mine) * dt, d = e.target - e.pos;
      if (Math.abs(d) > step) { e.pos += Math.sign(d) * step; return; }
      e.pos = e.target;
      if (e.target === 0) {
        e.state = "unload"; e.dur = elevatorStop(mine); e.t = e.dur; e.plan = e.u; e.planV = e.v;
      } else {
        const sh = mine.shafts[e.target - 1];
        e.plan = Math.min(sh.stock, cap - e.u);
        if (e.plan > 0.01) { e.state = "load"; e.dur = elevatorStop(mine); e.t = e.dur; }
        else elevatorNext(e, n, cap); // empty box: drive straight past
      }
    } else if (e.state === "load") {
      const k = e.target - 1, sh = mine.shafts[k];
      const du = Math.min((e.plan * Math.min(dt, e.t)) / e.dur, sh.stock);
      sh.stock -= du; e.u += du; e.v += du * unitValue(k, mine);
      e.t -= dt;
      if (e.t <= 0) elevatorNext(e, n, cap);
    } else {
      // unload at the surface into the drop pile
      const f = Math.min(dt, e.t) / e.dur;
      const du = Math.min(e.plan * f, e.u), dv = Math.min(e.planV * f, e.v);
      e.u -= du; e.v -= dv; mine.pile.u += du; mine.pile.v += dv;
      e.t -= dt;
      if (e.t <= 0) {
        mine.pile.u += e.u; mine.pile.v += e.v; e.u = e.v = 0;
        e.state = "idle"; e.t = 0.2;
      }
    }
  }

  // Warehouse workers: pick up from the drop pile -> walk to warehouse -> cash is added on arrival
  function updateWorkers(dt, mine, rm) {
    const wl = mine.warehouse.level, n = Math.min(4, 1 + Math.floor(wl / 5));
    syncWorkers(n);
    const carry = (warehouseSellRate(wl, rm.sellMult) * T_WORKER * hmult.c) / n;
    const pile = mine.pile;
    for (const w of workerSim) {
      const was = w.s;
      if (w.s === "wait") {
        w.t -= dt;
        if (w.t <= 0 && pile.u > 0.5) {
          const take = Math.min(pile.u, carry), v = (pile.v * take) / pile.u;
          pile.u -= take; pile.v -= v; w.v = v; w.s = "out";
        }
      } else if (w.s === "out") {
        w.p += (dt * hmult.s) / WALK_W;
        if (w.p >= 1) { w.p = 1; w.s = "drop"; w.t = 0.3; deliver(w.v); w.v = 0; }
      } else if (w.s === "drop") {
        w.t -= dt;
        if (w.t <= 0) w.s = "back";
      } else {
        w.p -= (dt * hmult.s) / WALK_W;
        if (w.p <= 0) { w.p = 0; w.s = "wait"; w.t = 0; }
      }
      if (w.s !== was) paint(w);
      w.el.style.left = w.p * 100 + "%";
    }
  }

  // A bottleneck = a real jam: floor boxes piling up (elevator) or the drop pile piling up (warehouse)
  function detectBottleneck(mine, rm) {
    const boxU = mine.shafts.slice(0, mine.unlockedShaftCount).reduce((s, sh) => s + sh.stock, 0);
    const rE = boxU / elevatorCapacity(mine.elevator.level, rm.elevatorCapMult);
    const rW = mine.pile.u / (warehouseSellRate(mine.warehouse.level, rm.sellMult) * T_WORKER);
    const e = rE > (bottleneck === "elevator" ? 1 : 1.5);
    const w = rW > (bottleneck === "warehouse" ? 1.5 : 2.5);
    const prev = bottleneck;
    bottleneck = e && (!w || rE >= rW) ? "elevator" : w ? "warehouse" : null;
    if (prev && !bottleneck) addXp(50); // hero cleared the jam
  }
