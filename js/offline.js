"use strict";
  function applyOfflineEarnings() {
    const elapsed = (Date.now() - state.lastSave) / 1000;
    if (elapsed < 60) return;
    const mine = activeMine(), rm = researchMult(), n = mine.unlockedShaftCount;
    let units = 0, value = 0;
    for (let i = 0; i < n; i++) {
      const u = floorUnitRate(i, mine, rm);
      units += u;
      value += u * unitValue(i, mine);
    }
    const cycle = (2 * n) / (1.4 + 0.15 * mine.elevator.level) + n * 0.45;
    const lift = elevatorCapacity(mine.elevator.level, rm.elevatorCapMult) / cycle;
    const sell = warehouseSellRate(mine.warehouse.level, rm.sellMult);
    const flow = Math.min(1, lift / units, sell / units);
    const earned = value * flow * elapsed * 0.5 * rm.offlineMult;
    window._pendingOffline = earned > 10 ? earned : 0;
    if (earned > 10) {
      document.getElementById("offline-amount").textContent = formatMoney(earned);
      document.getElementById("offline-modal").classList.remove("hidden");
    }
  }

  async function claimOffline(double) {
    let amt = window._pendingOffline || 0;
    if (double) {
      const r = await netBuy("offline2");
      if (!r.ok) return toast(r.error);
      amt *= 2;
    }
    state.cash += amt;
    state.stats.totalEarned += amt;
    window._pendingOffline = 0;
    document.getElementById("offline-modal").classList.add("hidden");
    saveState();
    renderHUD();
  }
